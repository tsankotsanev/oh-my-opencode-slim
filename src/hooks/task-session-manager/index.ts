import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobExecution,
  type BackgroundJobRecord,
  type BackgroundJobStore,
  type BackgroundJobSupervisor,
  type BackgroundTaskConcurrency,
  clearBackgroundJobSuppression,
  deriveFullObjective,
  deriveTaskSessionLabel,
  getBackgroundJobLifecycleLedger,
  isInternalInitiatorPart,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
  recordBackgroundJobSuppression,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import {
  consumeReviveIntent,
  consumeStopIntent,
  createServerSidecar,
  INTENT_RETENTION_MS,
  laneIntentsPath,
  readLaneIntents,
} from '../../utils/lane-control';
import {
  claimLaneWriters,
  createLaneMirror,
  releaseLaneWriters,
} from '../../utils/lane-mirror';
import { log } from '../../utils/logger';
import { createLaneServerUrlResolver } from '../../utils/server-url';
import { getRuntimeSessionStatusSnapshot } from '../../utils/session-runtime-status';
import type { SessionLifecycle } from '../session-lifecycle';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectedTerminalJobs,
  type InjectionState,
  injectBackgroundJobBoard,
  observeSyntheticTerminalPart,
  reconcileInjectedTerminalJobs,
  stabilizeRunningTaskParts,
  updateFromInjectedCompletion,
} from './board-injection';
import {
  type CascadeTracker,
  claimCascadeTracker,
  createCascadeTracker,
  type ReviveOnCascadeMode,
  releaseCascadeTracker,
} from './cascade-attribution';
import { handleEvent } from './event-router';
import { createIdleReconciler } from './idle-reconciliation';
import { createIdleSessionTokens } from './idle-session-tokens';
import { createInputWaitTracker } from './input-wait-tracker';
import {
  createPendingCallTracker,
  type PendingCallTracker,
} from './pending-call-tracker';
import { adoptRevivedRun, resumeRetainedLane } from './revive-run';
import type { RevivedRunTracker } from './revived-run-tracker';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';
import { createTaskContextTracker } from './task-context-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

export { BACKGROUND_JOB_BOARD_METADATA_KEY } from './board-injection';

/**
 * Delay before recording an idle observation on a child job. The observation
 * remains provisional; terminal task output is the only path that establishes
 * completed/error/cancelled state.
 */
const IDLE_RECONCILE_DELAY_MS = 2_000;

const RECOVERED_TASK_AGENT_FALLBACK = 'unknown';

function rehydrateHistoricalRunningTasks(
  messages: unknown[],
  backgroundJobBoard: BackgroundJobStore,
  shouldManageSession: (sessionID: string) => boolean,
  registerSessionAsOrchestrator?: (sessionID: string) => void,
  rehydrateTombstones?: ReadonlySet<string>,
  backgroundTaskConcurrency?: BackgroundTaskConcurrency,
  getModelForAgent?: (
    agentType: string,
    parentSessionID?: string,
  ) => string | undefined,
): number {
  let rehydrated = 0;
  const managedOrchestratorSessionIDs = new Set<string>();

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    if (message.info.agent !== 'orchestrator') continue;

    const parentSessionID = message.info.sessionID;
    if (!parentSessionID) continue;
    if (!shouldManageSession(parentSessionID)) {
      registerSessionAsOrchestrator?.(parentSessionID);
      if (!shouldManageSession(parentSessionID)) continue;
    }
    managedOrchestratorSessionIDs.add(parentSessionID);
  }

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;

    const parentSessionID = message.info.sessionID;
    if (
      !parentSessionID ||
      !managedOrchestratorSessionIDs.has(parentSessionID)
    ) {
      continue;
    }

    for (const part of message.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      if (!isObjectRecord(part.state)) continue;

      const state = part.state;
      if (typeof state.output !== 'string') continue;
      if (!isObjectRecord(state.input) || state.input.background !== true) {
        continue;
      }

      const taskID = parseTaskIdFromTaskOutput(state.output);
      if (!taskID || parseTaskStateFromOutput(state.output) !== 'running') {
        continue;
      }
      if (rehydrateTombstones?.has(taskID)) {
        // A real session.deleted already invalidated this run. Do not turn its
        // persisted running tool part into a fresh alias on the next request.
        continue;
      }
      if (backgroundJobBoard.get(taskID)) continue;

      const agent =
        typeof state.input.subagent_type === 'string' &&
        state.input.subagent_type.trim() !== ''
          ? state.input.subagent_type.trim()
          : RECOVERED_TASK_AGENT_FALLBACK;
      const description =
        typeof state.input.description === 'string'
          ? state.input.description
          : undefined;
      const prompt =
        typeof state.input.prompt === 'string' ? state.input.prompt : undefined;
      const label = deriveTaskSessionLabel({
        description,
        prompt,
        agentType: agent,
      });

      backgroundJobBoard.registerLaunch({
        taskID,
        parentSessionID,
        agent,
        description: label,
        objective: deriveFullObjective({ description, prompt }) ?? label,
        background: true,
        preserveRun: true,
        // Historical parts do not carry a trustworthy launch timestamp. Zero
        // also prevents this registration from looking like a live observation
        // to the first runtime-status reconciliation.
        now: 0,
      });
      // Re-claim the admission slot this still-running task already holds.
      // The scheduler is recreated on every plugin re-init (the factory re-
      // runs on config updates), so without this restore a fresh scheduler
      // would admit a second concurrent task past the configured cap. The
      // model resolution mirrors admission so provider/model caps stay
      // correct. Idempotent per taskID.
      backgroundTaskConcurrency?.restoreTask(
        taskID,
        getModelForAgent?.(agent, parentSessionID),
      );
      rehydrated += 1;
    }
  }

  return rehydrated;
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    strategy?: 'latest' | 'checkpoint-compatible';
    maxSessionsPerAgent: number;
    maxRetainedSnapshots: number;
    readContextMinLines?: number;
    readContextMaxFiles?: number;
    backgroundJobBoard?: BackgroundJobStore;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    /** Shared by plugin generations for one admission runtime. */
    pendingCallTracker?: PendingCallTracker;
    getModelForAgent?: (
      agentType: string,
      parentSessionID?: string,
    ) => string | undefined;
    shouldManageSession: (sessionID: string) => boolean;
    /** Register a session as orchestrator when the transform hook detects
     *  an orchestrator message but the session isn't in the agent map yet. */
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    /** Optional guard: when provided, idle events for a session that is
     *  currently undergoing a foreground-fallback abort/re-prompt cycle
     *  will NOT trigger idle reconciliation. prevents marking a still-
     *  active child job as completed when the session was aborted for
     *  model fallback rather than natural completion. */
    isFallbackInProgress?: (sessionID: string) => boolean;
    /** True when foreground fallback could still recover the session
     *  (enabled, chain exists, chain not exhausted). Lets the event
     *  router defer terminal bookkeeping for persistent 401/410 errors
     *  until recovery is impossible. */
    willAttemptFallback?: (sessionID: string) => boolean;
    coordinator?: SessionLifecycle;
    /** Test seam only; production always uses the reconciliation delay. */
    idleReconcileDelayMs?: number;
    /** Test seam only; production uses the runtime reconciliation delay. */
    runtimeStatusReconcileDelayMs?: number;
    /** `backgroundJobs.silenceDetection`; default on. */
    silenceDetection?: boolean;
    /** `backgroundJobs.staleAfterMs`; silence budget for a busy lane. */
    staleAfterMs?: number;
    /**
     * `backgroundJobs.laneControl` — the `omos lanes` control channel (board
     * mirror + server sidecar + stop intents).
     *
     * Defaults to OFF here even though the user-facing config defaults to on:
     * the flag is passed explicitly from `src/index.ts`, which is the only
     * caller that knows both the real project directory and the user's config.
     * A hook constructed in a test therefore never writes to the XDG data dir
     * unless it asks to.
     */
    laneControl?: boolean;
    /** Test seams for the lane-control artefacts. */
    laneMirrorFile?: string;
    laneServerInfoFile?: string;
    laneIntentsFile?: string;
    revivedRunTracker?: RevivedRunTracker;
    /**
     * `backgroundJobs.reviveOnCascade` — EXPERIMENTAL automatic resume of the
     * lanes one ESC killed. Defaults to `'off'`; attribution runs either way.
     */
    reviveOnCascade?: ReviveOnCascadeMode;
    /** Test seam: overrides the cascade tracker's timings/callbacks. */
    cascadeTracker?: CascadeTracker;
  },
) {
  const backgroundJobBoard =
    options.backgroundJobBoard ??
    new BackgroundJobBoard({
      maxReusablePerAgent: options.maxSessionsPerAgent,
      readContextMinLines: options.readContextMinLines,
      readContextMaxFiles: options.readContextMaxFiles,
    });
  const rehydrateState = getBackgroundJobLifecycleLedger(backgroundJobBoard);
  const rehydrateTombstones = rehydrateState.tombstones;

  const rememberDeletedSession = (sessionID: string): void => {
    const remember = (taskID: string): void => {
      recordBackgroundJobSuppression(backgroundJobBoard, taskID);
    };

    // The delete event itself is the lifecycle boundary. Keep a tombstone
    // even if an earlier cleanup already removed the board record.
    remember(sessionID);
    for (const job of backgroundJobBoard.list(sessionID)) {
      remember(job.taskID);
    }
  };

  const pendingCallTracker =
    options.pendingCallTracker ??
    createPendingCallTracker({
      releaseLease: (lease) => backgroundJobBoard.releaseLease(lease),
    });
  const taskContextTracker = createTaskContextTracker();

  const terminalJobsInjectedByParent = new Map<string, InjectedTerminalJobs>();
  const pendingInjectedTerminalJobsByParent = new Map<
    string,
    Map<string, BackgroundJobExecution>
  >();
  /** Managed sessions with a deferred inline 401/410 awaiting fallback outcome. */
  const deferredInlineErrors = new Set<string>();

  // Forward refs for circular deps — set after corresponding managers exist.
  // These are captured by closure in createIdleReconciler and only called
  // at runtime (event handlers), well after initialization completes.
  let getIdleSessionToken: (sessionID: string) => symbol = () => {
    throw new Error('unreachable: getIdleSessionToken not initialized');
  };
  let isCurrentIdleSessionToken: (
    sessionID: string,
    sessionToken: symbol,
  ) => boolean = () => false;
  let hasInputWait: (sessionID: string) => boolean = () => false;

  const idleReconciler = createIdleReconciler({
    backgroundJobBoard,
    reconcileInjectedTerminalJobs: (parentSessionID: string) =>
      reconcileInjectedTerminalJobs(injectionState, parentSessionID),
    // Fallback could not recover a deferred 401/410; drop the deferred
    // error and its injected-terminal tracking so the board shows the
    // failure and follow-up reconciliation keeps consistent state.
    onErrorTerminalize: (sessionID: string) => {
      deferredInlineErrors.delete(sessionID);
      terminalJobsInjectedByParent.delete(sessionID);
      pendingInjectedTerminalJobsByParent.delete(sessionID);
    },
    idleReconcileDelayMs:
      options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS,
    isFallbackInProgress: options.isFallbackInProgress,
    hasInputWait: (s) => hasInputWait(s),
    getIdleSessionToken: (s) => getIdleSessionToken(s),
    isCurrentIdleSessionToken: (s, t) => isCurrentIdleSessionToken(s, t),
    taskContextTracker,
    revivedRunTracker: options.revivedRunTracker,
  });
  const runtimeStatusReconciler = createRuntimeStatusReconciler({
    input: _ctx,
    backgroundJobBoard,
    delayMs: options.runtimeStatusReconcileDelayMs,
    silenceDetection: options.silenceDetection,
    staleAfterMs: options.staleAfterMs,
    // Resolved lazily: the input-wait tracker is created below.
    hasInputWait: (sessionID) => hasInputWait(sessionID),
    taskContextTracker,
  });

  const idleSessionTokens = createIdleSessionTokens({
    onInvalidate: idleReconciler.onInvalidateIdle,
  });
  getIdleSessionToken = (s) => idleSessionTokens.getSessionToken(s);
  isCurrentIdleSessionToken = (s, t) =>
    idleSessionTokens.isCurrentSessionToken(s, t);

  const inputWaits = createInputWaitTracker({
    shouldManageSession: options.shouldManageSession,
    invalidateIdle: (sessionID) => idleSessionTokens.invalidate(sessionID),
  });
  hasInputWait = (s) => inputWaits.hasInputWait(s);

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionId) => {
      // Fallback teardown keeps process-global wait_for_user; genuine delete
      // clears it via clearSession.
      if (options.isFallbackInProgress?.(sessionId)) {
        idleSessionTokens.invalidate(sessionId);
      } else {
        idleSessionTokens.clearSession(sessionId);
      }
      inputWaits.clearInputWaits(sessionId);
      idleReconciler.clearIdleTimers(sessionId);
      // During a foreground fallback abort/re-prompt cycle, the session
      // is being torn down and immediately recreated with a fallback model.
      // Dropping the job from the board here would make the orchestrator
      // lose track of the task and report it as cancelled even though the
      // oracle actually completed.
      if (!options.isFallbackInProgress?.(sessionId)) {
        options.backgroundTaskConcurrency?.releaseTask(sessionId);
        // The parent's child tasks are about to be dropped from the board.
        // Normally each child's own session.deleted releases its admission
        // slot, but a recursive delete can arrive parent-first, and a child
        // mid-fallback is skipped entirely — release every child's slot here
        // so none is left holding capacity forever. Idempotent per taskID.
        for (const child of backgroundJobBoard.list(sessionId)) {
          options.backgroundTaskConcurrency?.releaseTask(child.taskID);
        }
        options.backgroundJobSupervisor?.onSessionDeleted(sessionId);
        const hardTimedOut =
          backgroundJobBoard.field(sessionId, 'deadlineExceededAt') !==
          undefined;
        if (!hardTimedOut) {
          rememberDeletedSession(sessionId);
          backgroundJobBoard.drop(sessionId);
        }
        options.backgroundJobSupervisor?.clearParent(sessionId);
        backgroundJobBoard.clearParent(sessionId);
        if (!hardTimedOut) options.backgroundJobSupervisor?.drop(sessionId);
      }
      terminalJobsInjectedByParent.delete(sessionId);
      pendingInjectedTerminalJobsByParent.delete(sessionId);
      injectionState.retainedBoardSnapshots.delete(sessionId);
      injectionState.retainedTailBoards.delete(sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
    });
  }

  const injectionState: InjectionState = {
    backgroundJobBoard,
    maxRetainedSnapshots: options.maxRetainedSnapshots,
    strategy: options.strategy ?? 'latest',
    lifecycleLedger: rehydrateState,
    processedInjectedCompletions: rehydrateState.processedInjectedCompletions,
    processedInjectedCompletionOrder:
      rehydrateState.processedInjectedCompletionOrder,
    injectedCompletionFences: rehydrateState.injectedCompletionFences,
    syntheticTerminalOccurrences: rehydrateState.syntheticTerminalOccurrences,
    syntheticTerminalOccurrenceOrder:
      rehydrateState.syntheticTerminalOccurrenceOrder,
    getLifecycleEpoch: () => rehydrateState.nextEpoch,
    getDeletionEpoch: (taskID) => rehydrateState.deletionEpochs.get(taskID),
    terminalJobsInjectedByParent,
    pendingInjectedTerminalJobsByParent,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: options.shouldManageSession,
    taskContextTracker,
    retainedBoardSnapshots: new Map(),
    retainedTailBoards: new Map(),
  };

  // Early session.created registrations belong to the pending native call,
  // not to the factory-local board that first observed them. Move them before
  // this generation can receive the task after-hook.
  pendingCallTracker.adoptEarlyRegistrations(
    backgroundJobBoard,
    options.backgroundJobSupervisor,
  );

  // ── Lane control (`omos lanes`) ────────────────────────────────────
  // Write-only, out-of-band, and never read back: the mirror exists so a
  // SECOND terminal can list/steer lanes at zero token cost, while this
  // process keeps rehydrating from the transcript exactly as before. See
  // src/utils/lane-mirror.ts for why the direction of each file is a rule.
  const laneControlEnabled = options.laneControl === true;
  const laneIntentsFile = laneControlEnabled
    ? (options.laneIntentsFile ?? laneIntentsPath(_ctx.directory))
    : undefined;
  const laneServerSidecar = createServerSidecar({
    directory: _ctx.directory,
    enabled: laneControlEnabled,
    resolveServerUrl: createLaneServerUrlResolver(_ctx),
    ...(options.laneServerInfoFile ? { file: options.laneServerInfoFile } : {}),
  });

  /**
   * Label lanes the user stopped from the CLI when no abort event could carry
   * the attribution.
   *
   * `omos lanes stop` on a lane that is ALREADY terminal (an ESC cascade or a
   * silent failure got there first) records the cancellation but has nothing
   * to abort, so `session.error` never arrives and the event-router claim in
   * `claimUserStopIntent` never fires. Without this sweep the CLI's "recorded
   * as your cancellation" would be a promise nothing keeps.
   *
   * Runs from the mirror's own flush, so it costs one read of a normally
   * absent file per second at most — never one per event. Only terminal,
   * unlabelled, non-orchestrator-cancelled records are eligible: an intent for
   * a still-`running` lane belongs to the abort that is about to arrive, and
   * claiming it here would steal the attribution from the real event.
   */
  const claimSettledUserStops = (): void => {
    if (!laneIntentsFile) return;
    // One read (a missing file costs one failed open), and only then a claim.
    const pending = readLaneIntents(laneIntentsFile);
    for (const intent of pending) {
      const job = backgroundJobBoard.get(intent.sessionID);
      if (!job) continue;
      if (job.state !== 'error' && job.state !== 'stopped') continue;
      if (job.cancelledByUser !== undefined) continue;
      if (job.cancellationRequested) continue;
      // Claimed against the full retention window rather than the 60s abort
      // window: this intent has no event to correlate with, it is a standalone
      // statement that the user ended this lane.
      const claimed = consumeStopIntent(laneIntentsFile, intent.sessionID, {
        withinMs: INTENT_RETENTION_MS,
      });
      if (!claimed) continue;
      const labelled = backgroundJobBoard.markCancelledByUser(
        intent.sessionID,
        claimed.reason,
      );
      log('[task-session-manager] settled lane labelled as user-stopped', {
        sessionID: intent.sessionID,
        alias: labelled?.alias,
        state: labelled?.state,
        reason: claimed.reason,
      });
    }
  };

  const laneMirror = createLaneMirror({
    directory: _ctx.directory,
    enabled: laneControlEnabled,
    lanes: () => backgroundJobBoard.list(),
    // Bookkeeping that must be visible in the file about to be written.
    onBeforeFlush: claimSettledUserStops,
    // A flush means "the plugin looked", not "a lane changed" (the write
    // itself is skipped when the content is identical). It is still the
    // cheapest cadence available for proving the server is alive.
    onFlush: () => laneServerSidecar.refresh(),
    ...(options.laneMirrorFile ? { file: options.laneMirrorFile } : {}),
  });
  const claimUserStopIntent = laneIntentsFile
    ? (sessionID: string): { reason?: string } | undefined =>
        consumeStopIntent(laneIntentsFile, sessionID)
    : undefined;

  // ── ESC attribution and recovery ───────────────────────────────────
  const revivedRunTracker = options.revivedRunTracker;
  const retainedRunDeps = revivedRunTracker
    ? {
        input: _ctx,
        backgroundJobBoard,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        revivedRunTracker,
      }
    : undefined;

  /**
   * Adopt the run `omos lanes revive` started from another process.
   *
   * Needs the revived-run tracker: without it there would be nobody to
   * synthesize the parent's terminal notification, which is the entire reason
   * the CLI hands the run over instead of just prompting and walking away.
   */
  const adoptUserRevive =
    laneIntentsFile && retainedRunDeps
      ? async (sessionID: string): Promise<void> => {
          try {
            const adopted = await adoptRevivedRun(retainedRunDeps, sessionID);
            log('[task-session-manager] lane revived by user (omos lanes)', {
              sessionID,
              alias: adopted?.alias,
              generation: adopted?.generation,
              adopted: adopted !== undefined,
            });
          } catch (error) {
            // WARNING, not a note: the intent has already been CLAIMED by the
            // caller, so this is the only record that a run the user started
            // is now unsupervised. The session is genuinely running (the CLI
            // prompted it and got a 204) but no generation was registered, so
            // the board keeps showing the lane as interrupted and the parent
            // will never be told how the run ended.
            //
            // The intent is deliberately NOT re-appended: the next busy signal
            // would adopt a run that is already mid-turn, and `launchRetainedRun`
            // has by then left the record `statusUncertain` — replaying that is
            // a worse outcome than an unsupervised lane the board still lists.
            log(
              '[task-session-manager] WARNING: user revive adoption failed; run is live but unsupervised',
              {
                sessionID,
                error: error instanceof Error ? error.message : String(error),
                consequence:
                  'no generation registered: the board keeps this lane as interrupted and the parent gets no terminal notification',
                remedy: `check \`omos lanes show\`; ask the orchestrator for task_revive once the session is idle again`,
              },
            );
          }
          laneMirror.scheduleFlush();
        }
      : undefined;

  const cascadeTracker =
    options.cascadeTracker ??
    createCascadeTracker({
      backgroundJobBoard,
      mode: options.reviveOnCascade ?? 'off',
      fetchSessionStatuses: () => getRuntimeSessionStatusSnapshot(_ctx),
      // Absent when no tracker was wired: attribution still runs, but nothing
      // is ever restarted, which is the safe half of the feature.
      ...(retainedRunDeps
        ? {
            reviveLane: async (record: BackgroundJobRecord): Promise<void> => {
              await resumeRetainedLane(retainedRunDeps, record);
              laneMirror.scheduleFlush();
            },
          }
        : {}),
      ...(laneIntentsFile
        ? {
            claimStopIntent: (sessionID: string, sinceMs: number) =>
              consumeStopIntent(laneIntentsFile, sessionID, {
                withinMs: sinceMs,
              }),
          }
        : {}),
    });

  const claimUserReviveIntent = laneIntentsFile
    ? (sessionID: string): { at: number } | undefined =>
        consumeReviveIntent(laneIntentsFile, sessionID)
    : undefined;

  /**
   * Tear down this generation's writers, and let a newer generation take over.
   *
   * Registered module-side so the plugin factory re-running (every config
   * update) cannot leave two mirrors and two sidecar heartbeats fighting over
   * one directory.
   */
  const disposeLaneWriters = (): void => {
    laneMirror.dispose();
    laneServerSidecar.dispose();
    releaseLaneWriters(_ctx.directory, disposeLaneWriters);
  };
  if (laneControlEnabled) claimLaneWriters(_ctx.directory, disposeLaneWriters);

  /**
   * Tear down this generation's cascade tracker.
   *
   * Claimed UNCONDITIONALLY, unlike the lane writers: attribution and
   * auto-revive run whether or not `backgroundJobs.laneControl` is on, and the
   * factory re-runs on every CONFIG update. A restart still pending under
   * `reviveOnCascade: 'auto'` must not fire after the user has just switched
   * it to `'off'`, and gating that teardown on an unrelated feature flag is
   * how it would.
   */
  const disposeCascadeTracker = (): void => {
    cascadeTracker.dispose();
    releaseCascadeTracker(_ctx.directory, disposeCascadeTracker);
  };
  claimCascadeTracker(_ctx.directory, disposeCascadeTracker);

  return {
    markRevivedRunPending: (taskID: string): void => {
      taskContextTracker.pendingManagedTaskIds.add(taskID);
    },
    clearRevivedRunPending: (taskID: string): void => {
      taskContextTracker.pendingManagedTaskIds.delete(taskID);
    },
    contextFilesForTask: (taskID: string) =>
      taskContextTracker.contextFilesForPrompt(taskID),
    pruneTaskContext: (): void => {
      taskContextTracker.prune(backgroundJobBoard);
    },
    beginUserWait: (sessionID: string): void => {
      inputWaits.beginUserWait(sessionID);
    },

    /**
     * Narrow exposure for the orchestrator-wake scheduler: true while a
     * question/permission is open or wait_for_user is latched.
     */
    hasInputWait: (sessionID: string): boolean => hasInputWait(sessionID),

    observeChatMessage: (input: unknown, output: unknown): void => {
      const inputMessage = isObjectRecord(input) ? input : undefined;
      const outputRecord = isObjectRecord(output) ? output : undefined;
      const outputMessage = isObjectRecord(outputRecord?.message)
        ? outputRecord.message
        : undefined;
      const sessionID =
        typeof outputMessage?.sessionID === 'string'
          ? outputMessage.sessionID
          : typeof inputMessage?.sessionID === 'string'
            ? inputMessage.sessionID
            : undefined;
      const parts = Array.isArray(outputRecord?.parts)
        ? outputRecord.parts
        : inputMessage?.parts;
      // Safe identity order (Oracle): input.messageID → output.message.id →
      // same-process output.message object → fail closed.
      const messageIdentity: string | object | undefined =
        typeof inputMessage?.messageID === 'string' &&
        inputMessage.messageID.length > 0
          ? inputMessage.messageID
          : typeof outputMessage?.id === 'string' && outputMessage.id.length > 0
            ? outputMessage.id
            : outputMessage;
      if (
        !sessionID ||
        messageIdentity === undefined ||
        (typeof outputMessage?.role === 'string' &&
          outputMessage.role !== 'user') ||
        !options.shouldManageSession(sessionID) ||
        !Array.isArray(parts) ||
        parts.some(isInternalInitiatorPart) ||
        !parts.some(
          (part) =>
            isObjectRecord(part) &&
            part.synthetic !== true &&
            !isInternalInitiatorPart(part) &&
            ((part.type === 'text' && typeof part.text === 'string') ||
              part.type === 'file' ||
              part.type === 'image'),
        )
      ) {
        return;
      }
      idleSessionTokens.onExternalUserMessage(sessionID, messageIdentity);
    },

    'tool.execute.before': (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> =>
      handleToolExecuteBefore(input, output, {
        shouldManageSession: options.shouldManageSession,
        registerSessionAsOrchestrator: options.registerSessionAsOrchestrator,
        backgroundJobBoard,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        backgroundTaskConcurrency: options.backgroundTaskConcurrency,
        getModelForAgent: options.getModelForAgent,
        pendingCallTracker,
        taskContextTracker,
        getLifecycleEpoch: () => rehydrateState.nextEpoch,
      }),

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      await handleToolExecuteAfter(input, output, {
        directory: _ctx.directory,
        backgroundJobBoard,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        releaseConcurrencyTask: (taskID) =>
          options.backgroundTaskConcurrency?.releaseTask(taskID),
        recordLifecycleSuppression: (taskID) =>
          recordBackgroundJobSuppression(backgroundJobBoard, taskID),
        pendingCallTracker,
        taskContextTracker,
        clearRehydrateTombstone: (taskID) => {
          clearBackgroundJobSuppression(backgroundJobBoard, taskID);
        },
        isStaleDeletedTaskOutput: (taskID, lifecycleEpoch) => {
          const deletionEpoch = rehydrateState.deletionEpochs.get(taskID);
          return deletionEpoch !== undefined && lifecycleEpoch < deletionEpoch;
        },
      });
      runtimeStatusReconciler.schedule();
      laneMirror.scheduleFlush();
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      // Keep still-running task tool results byte-stable so a live background
      // lane never rewrites mid-history bytes and invalidates the prompt
      // cache. Terminal results are left untouched (they materialize once).
      stabilizeRunningTaskParts(messages);

      const rehydratedCount = rehydrateHistoricalRunningTasks(
        messages,
        backgroundJobBoard,
        options.shouldManageSession,
        options.registerSessionAsOrchestrator,
        rehydrateTombstones,
        options.backgroundTaskConcurrency,
        options.getModelForAgent,
      );

      for (const [messageIndex, message] of messages.entries()) {
        if (!isUserMessageWithParts(message)) continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') {
          continue;
        }
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          const sessionID = message.info.sessionID;
          if (!sessionID || message.info.agent !== 'orchestrator') {
            continue;
          }
          options.registerSessionAsOrchestrator?.(sessionID);
          if (!options.shouldManageSession(sessionID)) continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
          updateFromInjectedCompletion(
            injectionState,
            part,
            message,
            messageIndex,
            partIndex,
          );
        }
      }

      if (rehydratedCount > 0) {
        await runtimeStatusReconciler.reconcile();
        // Rehydration is the one board mutation with no event behind it, so
        // the mirror would otherwise miss lanes recovered after a restart.
        laneMirror.scheduleFlush();
      }
    },

    injectBackgroundJobBoard: (
      input: Record<string, never>,
      output: { messages?: unknown },
    ) => injectBackgroundJobBoard(injectionState, input, output),

    event: (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string; agent?: string };
          id?: string;
          requestID?: string;
          sessionID?: string;
          status?: { type?: string };
          error?: { name?: string };
          part?: unknown;
        };
      };
    }): Promise<void> => {
      if (input.event.type === 'session.deleted') {
        const sessionID =
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
        if (sessionID) {
          deferredInlineErrors.delete(sessionID);
          if (!options.isFallbackInProgress?.(sessionID)) {
            const hardTimedOut =
              backgroundJobBoard.field(sessionID, 'deadlineExceededAt') !==
              undefined;
            if (!hardTimedOut) rememberDeletedSession(sessionID);
          }
        }
      }

      if (input.event.type === 'server.instance.disposed') {
        runtimeStatusReconciler.dispose();
        disposeCascadeTracker();
        // Flush last, then drop the sidecar: a missing sidecar makes the CLI
        // say "start OpenCode or pass --server", whereas a stale one would
        // send it at a dead (or recycled) port.
        disposeLaneWriters();
      }
      return handleEvent(input, {
        inputWaits,
        idleSessionTokens,
        options,
        idleReconciler,
        deferredInlineErrors,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
        terminalJobsInjectedByParent,
        pendingInjectedTerminalJobsByParent,
        retainedBoardSnapshots: injectionState.retainedBoardSnapshots,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        observeSyntheticTerminalPart: (part) =>
          observeSyntheticTerminalPart(injectionState, part),
        revivedRunTracker: options.revivedRunTracker,
        cascade: cascadeTracker,
        ...(claimUserStopIntent ? { claimUserStopIntent } : {}),
        ...(claimUserReviveIntent ? { claimUserReviveIntent } : {}),
        ...(adoptUserRevive ? { adoptRevivedRun: adoptUserRevive } : {}),
      }).then(() => {
        runtimeStatusReconciler.schedule();
        laneMirror.scheduleFlush();
      });
    },
  };
}
