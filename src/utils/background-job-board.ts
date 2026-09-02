import {
  DEFAULT_MAX_CONTEXT_LINES,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  formatSystemReminder,
} from '../config/constants';
import type { BackgroundJobStore } from './background-job-store';
import {
  clearBackgroundJobSuppression,
  recordBackgroundJobSuppression,
} from './background-job-store';
import { log } from './logger';
import {
  guardCompletedStatusText,
  parseTaskStatusOutput,
  type TaskOutputState,
} from './task';

export interface ContextFile {
  path: string;
  lineCount: number;
  lineNumbers?: number[];
  lastReadAt: number;
}

export interface BackgroundJobExecution {
  taskID: string;
  generation: number;
}

export type BackgroundJobLeaseKind =
  | 'cancellation'
  | 'relaunch'
  | 'message'
  | 'terminal-notification';

/** Process-local ownership of a remote operation or same-ID relaunch. */
export interface BackgroundJobLease {
  taskID: string;
  generation: number;
  token: string;
  kind: BackgroundJobLeaseKind;
}

export interface BackgroundJobPromptMetadata {
  text: string | undefined;
  terminalUnreconciledTaskIDs: BackgroundJobExecution[];
}

export type BackgroundJobState = TaskOutputState | 'stopped' | 'reconciled';

/**
 * Partial work observed on a lane, captured from one `session.messages` probe.
 *
 * Lets the parent see what a silent lane was doing instead of guessing from
 * file diffs. `capturedAt` is bookkeeping only: it rate-limits re-probing and
 * is deliberately never rendered, so the board stays byte-stable over time.
 */
export interface LaneProgress {
  /** First ~300 chars of the most recent assistant text part. */
  text?: string;
  lastTool?: { name: string; status: string };
  messageCount: number;
  capturedAt: number;
}

/** Open permission prompt on a lane; `permissionID` fences the clear. */
export interface AwaitingPermission {
  tool: string;
  at: number;
  permissionID?: string;
}

export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  /** True only when the native task call explicitly supplied background:true. */
  background: boolean;
  timedOut: boolean;
  recoverableAfterLiveBusy: boolean;
  statusUncertain: boolean;
  cancellationRequested: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  /** Monotonic run identity. Explicit relaunch/reuse increments it. */
  generation: number;
  /** Task-local run identity; unlike generation, unrelated tasks do not affect it. */
  taskGeneration: number;
  /** First launch observation for the current generation. */
  runStartedAt: number;
  /** Persistent hard wall-clock marker; distinct from external task wait timeout. */
  deadlineExceededAt?: number;
  updatedAt: number;
  lastLiveBusyAt?: number;
  /**
   * Last observed child OUTPUT (message/part events).
   *
   * Deliberately distinct from {@link lastLiveBusyAt}: a `busy` status merely
   * repeats "still nominally mid-turn", which for a hung provider stream is
   * the freeze signature itself, not evidence of progress.
   */
  lastActivityAt?: number;
  /**
   * Set when silence detection flagged this lane as busy-but-silent.
   *
   * Its presence is what makes the flag survive the liveness poller's
   * `busy` observations; real activity (`recordActivity`) clears it.
   */
  silenceDetectedAt?: number;
  /**
   * Reason text frozen at the silence transition.
   *
   * Never rewritten while the lane stays silent: recomputing the seconds count
   * every cycle would churn the rendered board bytes (and bust the prompt
   * cache) for a lane whose state has not actually changed.
   */
  silenceReason?: string;
  /** Partial work captured by the most recent silence probe. */
  lastProgress?: LaneProgress;
  /**
   * Open permission prompt for this lane.
   *
   * A lane blocked on a human answering a permission request is silent by
   * design, so this both exempts it from silence detection and gives the
   * parent (and `omo lanes list`) the one fact that explains the pause. The
   * timestamp is bookkeeping only and is deliberately never rendered.
   */
  awaitingPermission?: AwaitingPermission;
  /**
   * The user stopped this lane from a second terminal (`omo lanes stop`).
   *
   * A LABEL, never a state: the terminal state itself is still whatever the
   * lifecycle recorded (an aborted child lands as `error`), so a lost or
   * duplicated intent line can only change the wording the orchestrator
   * reads, never whether the lane is considered finished.
   */
  cancelledByUser?: { at: number; reason?: string };
  /** First non-busy runtime observation for the current stop-confirmation grace. */
  stopConfirmationStartedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  lastStatusError?: string;
  alias: string;
  lastUsedAt: number;
  terminalState?: TaskOutputState;
  contextFiles: ContextFile[];
  totalErrors?: number;
  timeoutCount?: number;
  lastErrorAt?: number;
}

export interface BackgroundJobBoardOptions {
  maxReusablePerAgent?: number;
  maxContextLines?: number;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
}

export interface BackgroundJobLaunchInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description?: string;
  objective?: string;
  background?: boolean;
  /** Preserve the current run when this is a duplicate lifecycle observation. */
  preserveRun?: boolean;
  /** Lease proving that this is an authorized same-ID relaunch observation. */
  relaunchLease?: BackgroundJobLease;
  /** Backwards-compatible generic spelling for the relaunch lease. */
  lease?: BackgroundJobLease;
  now?: number;
}

export interface BackgroundJobStatusInput {
  taskID: string;
  state: TaskOutputState;
  /** Ignore native output from an older run of the same task ID. */
  expectedGeneration?: number;
  timedOut?: boolean;
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
  now?: number;
}

export interface WallClockTimeoutClaimInput {
  taskID: string;
  generation: number;
  now?: number;
  resultSummary?: string;
}

export interface WallClockTimeoutFinalizeInput {
  taskID: string;
  generation: number;
  now?: number;
  statusUncertain: boolean;
  resultSummary: string;
}

type TerminalStateListener = (taskID: string) => void;

export class BackgroundJobLaunchConflictError extends Error {
  constructor(taskID: string, message: string) {
    super(`Cannot register launch for ${taskID}: ${message}`);
    this.name = 'BackgroundJobLaunchConflictError';
  }
}

const CANONICAL_TERMINAL_STATES = new Set<TaskOutputState>([
  'completed',
  'error',
  'cancelled',
]);

const AGENT_PREFIX: Record<string, string> = {
  council: 'cou',
  designer: 'des',
  explorer: 'exp',
  fixer: 'fix',
  librarian: 'lib',
  observer: 'obs',
  oracle: 'ora',
};

export class BackgroundJobBoard implements BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  /** One live operation/relaunch owner per native session ID. */
  private readonly liveLeases = new Map<string, BackgroundJobLease>();
  private readonly counters = new Map<string, number>();
  private executionSequence = 0;
  private leaseSequence = 0;
  private terminalStateListeners: TerminalStateListener[] = [];

  private readonly maxReusablePerAgent: number;
  private readonly maxContextLines: number;
  private readonly readContextMinLines: number;
  private readonly readContextMaxFiles: number;

  constructor(options: BackgroundJobBoardOptions = {}) {
    this.maxReusablePerAgent =
      options.maxReusablePerAgent ?? DEFAULT_MAX_SESSIONS_PER_AGENT;
    this.maxContextLines = options.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES;
    this.readContextMinLines =
      options.readContextMinLines ?? DEFAULT_READ_CONTEXT_MIN_LINES;
    this.readContextMaxFiles =
      options.readContextMaxFiles ?? DEFAULT_READ_CONTEXT_MAX_FILES;
  }

  addTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners.push(listener);
  }

  removeTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners = this.terminalStateListeners.filter(
      (entry) => entry !== listener,
    );
  }

  setTerminalStateListener(listener?: TerminalStateListener): void {
    this.terminalStateListeners = listener ? [listener] : [];
  }

  private notifyTerminalStateListeners(taskID: string): void {
    for (const listener of this.terminalStateListeners) {
      try {
        listener(taskID);
      } catch (error) {
        log('Board terminal state listener threw', {
          taskID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    const now = input.now ?? Date.now();
    const existing = this.jobs.get(input.taskID);
    const requestedLease = input.relaunchLease ?? input.lease;
    const liveLease = this.liveLeases.get(input.taskID);

    if (requestedLease) {
      if (
        requestedLease.kind !== 'relaunch' ||
        !this.validateLease(requestedLease) ||
        requestedLease.taskID !== input.taskID ||
        existing?.generation !== requestedLease.generation
      ) {
        throw new BackgroundJobLaunchConflictError(
          input.taskID,
          'the relaunch lease is missing, stale, or belongs to another generation',
        );
      }
    }

    if (liveLease) {
      if (
        liveLease.kind !== 'relaunch' ||
        requestedLease === undefined ||
        !this.validateLease(requestedLease)
      ) {
        throw new BackgroundJobLaunchConflictError(
          input.taskID,
          `a ${liveLease.kind} lease already owns this session`,
        );
      }
    }

    clearBackgroundJobSuppression(this, input.taskID);
    const generation = ++this.executionSequence;

    if (existing) {
      if (input.preserveRun) {
        if (existing.state !== 'running') return existing;
        const observed = {
          ...existing,
          agent: input.agent || existing.agent,
          description: input.description || existing.description,
          objective: input.objective ?? existing.objective,
          background: existing.background || input.background === true,
        } satisfies BackgroundJobRecord;
        this.jobs.set(input.taskID, observed);
        return observed;
      }

      const updated = {
        ...existing,
        generation,
        taskGeneration: existing.taskGeneration + 1,
        agent: input.agent || existing.agent,
        description: input.description || existing.description,
        objective: input.objective ?? existing.objective,
        state: 'running',
        background: input.background ?? existing.background,
        timedOut: false,
        recoverableAfterLiveBusy: false,
        statusUncertain: false,
        cancellationRequested: false,
        terminalUnreconciled: false,
        completedAt: undefined,
        resultSummary: undefined,
        lastStatusError: undefined,
        terminalState: undefined,
        lastLaunchedAt: now,
        runStartedAt: now,
        deadlineExceededAt: undefined,
        lastLiveBusyAt: now,
        lastActivityAt: undefined,
        silenceDetectedAt: undefined,
        silenceReason: undefined,
        lastProgress: undefined,
        awaitingPermission: undefined,
        cancelledByUser: undefined,
        stopConfirmationStartedAt: undefined,
        lastUsedAt: now,
        updatedAt: now,
        totalErrors: existing.totalErrors ?? 0,
        timeoutCount: existing.timeoutCount ?? 0,
      } satisfies BackgroundJobRecord;
      this.jobs.set(input.taskID, updated);
      return updated;
    }

    const record: BackgroundJobRecord = {
      taskID: input.taskID,
      generation,
      taskGeneration: 1,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      description: input.description || `background ${input.agent} task`,
      objective: input.objective,
      state: 'running',
      background: input.background === true,
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: false,
      terminalUnreconciled: false,
      launchedAt: now,
      lastLaunchedAt: now,
      runStartedAt: now,
      lastLiveBusyAt: now,
      lastUsedAt: now,
      updatedAt: now,
      alias: this.nextAlias(input.parentSessionID, input.agent),
      contextFiles: [],
      totalErrors: 0,
      timeoutCount: 0,
    };

    this.jobs.set(input.taskID, record);
    return record;
  }

  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;
    if (
      input.expectedGeneration !== undefined &&
      existing.generation !== input.expectedGeneration
    ) {
      return existing;
    }

    // A wall-clock deadline is a hard, non-recoverable claim. Completion after
    // that claim is late evidence and cannot replace the canonical timeout.
    if (existing.deadlineExceededAt !== undefined) {
      if (existing.state !== 'running') return existing;
      if (input.state === 'completed' || input.state === 'running') {
        return existing;
      }
      return this.finalizeWallClockTimeout({
        taskID: input.taskID,
        generation: existing.generation,
        now: input.now,
        statusUncertain: false,
        resultSummary: existing.resultSummary ?? timeoutSummary(input.state),
      });
    }

    // Guard: stale status updates cannot reopen already terminal jobs.
    if (
      existing.state === 'reconciled' ||
      (existing.state === 'stopped' && input.state === 'running') ||
      (existing.state === 'cancelled' && input.state !== 'cancelled') ||
      (isCanonicalTerminalState(existing.state) && input.state === 'running')
    ) {
      return existing;
    }

    const now = input.now ?? Date.now();
    const terminal = input.state !== 'running';
    const notifyTerminal =
      terminal && !isCanonicalTerminalState(existing.state);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: input.state,
      timedOut: input.timedOut ?? false,
      recoverableAfterLiveBusy:
        input.state !== 'running'
          ? false
          : input.timedOut === true
            ? false
            : existing.recoverableAfterLiveBusy,
      statusUncertain: input.statusUncertain ?? false,
      terminalUnreconciled: terminal ? true : existing.terminalUnreconciled,
      updatedAt: now,
      completedAt: terminal
        ? (existing.completedAt ?? now)
        : existing.completedAt,
      terminalState: terminal ? input.state : existing.terminalState,
      resultSummary: input.resultSummary ?? existing.resultSummary,
      lastStatusError: input.lastStatusError,
      stopConfirmationStartedAt:
        input.state === 'running'
          ? existing.stopConfirmationStartedAt
          : undefined,
      // A terminal result answers the question the silence flag was asking.
      silenceDetectedAt: terminal ? undefined : existing.silenceDetectedAt,
      silenceReason: terminal ? undefined : existing.silenceReason,
      // Same for an open permission prompt: whatever it was waiting for, the
      // run is over and the stamp would only mislead the parent.
      awaitingPermission: terminal ? undefined : existing.awaitingPermission,
    };

    if (input.state === 'completed') {
      updated.timeoutCount = 0;
    }
    if (input.state === 'error') {
      updated.totalErrors = (existing.totalErrors ?? 0) + 1;
      updated.lastErrorAt = updated.updatedAt;
    }
    if (input.timedOut && input.state !== 'completed') {
      updated.timeoutCount = (existing.timeoutCount ?? 0) + 1;
    }

    this.jobs.set(input.taskID, updated);
    this.trimReusable(input.taskID);
    if (notifyTerminal) this.notifyTerminalStateListeners(input.taskID);
    return updated;
  }

  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined {
    const status = parseTaskStatusOutput(output);
    if (!status) return undefined;

    const guarded = guardCompletedStatusText(
      status.state,
      status.result,
      this.get(status.taskID)?.resultSummary,
    );

    return this.updateStatus({
      taskID: status.taskID,
      state: guarded.state,
      timedOut: status.timedOut,
      resultSummary: guarded.resultSummary,
      lastStatusError: guarded.lastStatusError,
    });
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }

    if (existing.deadlineExceededAt !== undefined) return existing;

    const isStaleTerminal =
      isCanonicalTerminalState(existing.state) ||
      existing.state === 'reconciled' ||
      (existing.state === 'stopped' && !existing.terminalUnreconciled);
    if (isStaleTerminal) {
      const updated: BackgroundJobRecord = {
        ...existing,
        lastLiveBusyAt: now,
      };
      this.jobs.set(taskID, updated);
      return updated;
    }

    if (
      existing.state === 'stopped' &&
      existing.completedAt !== undefined &&
      now <= existing.completedAt
    ) {
      const updated: BackgroundJobRecord = {
        ...existing,
        lastLiveBusyAt: now,
      };
      this.jobs.set(taskID, updated);
      return updated;
    }

    // A live `busy` observation normally resolves every kind of uncertainty.
    // Silence detection is the one exception: its whole claim is that this
    // session reports busy while producing nothing, so letting the poller's
    // own busy reading clear the flag would erase it every 5 seconds. Only
    // real activity (`recordActivity`) or a terminal result may clear it.
    const silent = existing.silenceDetectedAt !== undefined;
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'running',
      updatedAt: now,
      lastLiveBusyAt: now,
      stopConfirmationStartedAt: undefined,
      timedOut: false,
      recoverableAfterLiveBusy:
        existing.recoverableAfterLiveBusy || existing.timedOut,
      statusUncertain: silent,
      terminalUnreconciled: false,
      completedAt:
        existing.state === 'stopped' ? undefined : existing.completedAt,
      resultSummary:
        existing.state === 'stopped' ? undefined : existing.resultSummary,
      lastStatusError: silent ? existing.silenceReason : undefined,
      terminalState:
        existing.state === 'stopped' ? undefined : existing.terminalState,
    };

    this.jobs.set(taskID, updated);
    return updated;
  }

  /**
   * Record observed child output as the lane's activity heartbeat.
   *
   * Called from the event router for message/part events on known child
   * sessions. Output is proof of life, so it also releases a silence flag —
   * unlike a `busy` status, which proves nothing for a hung stream.
   */
  recordActivity(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }

    const lastActivityAt = Math.max(existing.lastActivityAt ?? 0, now);
    if (existing.silenceDetectedAt === undefined) {
      // Output while a permission prompt is stamped means the lane moved on
      // without us seeing the reply (a dropped event, or a plugin restart).
      // Self-healing beats a stamp that nothing can remove.
      const dropsPermissionStamp = existing.awaitingPermission !== undefined;
      if (lastActivityAt === existing.lastActivityAt && !dropsPermissionStamp) {
        return existing;
      }
      // Otherwise a heartbeat only: no state transition, so nothing else on
      // the record (and nothing rendered) changes.
      const beat: BackgroundJobRecord = {
        ...existing,
        lastActivityAt,
        awaitingPermission: undefined,
        ...(dropsPermissionStamp ? { updatedAt: now } : {}),
      };
      this.jobs.set(taskID, beat);
      return beat;
    }

    // The lane came back. Drop the flag, its frozen reason and the stale
    // progress excerpt captured while it was quiet.
    const revived: BackgroundJobRecord = {
      ...existing,
      lastActivityAt,
      awaitingPermission: undefined,
      silenceDetectedAt: undefined,
      silenceReason: undefined,
      lastProgress: undefined,
      statusUncertain: false,
      lastStatusError: undefined,
      updatedAt: now,
    };
    this.jobs.set(taskID, revived);
    return revived;
  }

  /**
   * Flag a running lane as busy-but-silent past the staleness threshold.
   *
   * Modelled as `statusUncertain` plus a frozen reason rather than a new board
   * state: the lane may still be alive, and nothing here proves a terminal
   * outcome. Re-marking an already-silent lane refreshes the captured progress
   * but never rewrites the reason.
   */
  markSilenceDetected(
    taskID: string,
    reason: string,
    options: {
      progress?: LaneProgress;
      now?: number;
      expectedGeneration?: number;
    } = {},
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      options.expectedGeneration !== undefined &&
      existing.generation !== options.expectedGeneration
    ) {
      return existing;
    }
    if (existing.deadlineExceededAt !== undefined) return existing;

    const now = options.now ?? Date.now();
    const frozenReason = existing.silenceReason ?? reason;
    const updated: BackgroundJobRecord = {
      ...existing,
      statusUncertain: true,
      lastStatusError: frozenReason,
      silenceDetectedAt: existing.silenceDetectedAt ?? now,
      silenceReason: frozenReason,
      lastProgress: options.progress ?? existing.lastProgress,
      updatedAt:
        existing.silenceDetectedAt === undefined ? now : existing.updatedAt,
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  /**
   * Stamp an open permission prompt on a RUNNING lane.
   *
   * Only while running, deliberately: the stamp's whole purpose is to explain
   * why a live lane is quiet, and a stamp that could be applied to a settled
   * record would outlive the question it describes (Gate-3 M2). It is cleared
   * by {@link clearAwaitingPermission} on the reply, by {@link recordActivity}
   * when the lane produces output again, and by every terminal transition, so
   * a missed `permission.replied` cannot make the exemption permanent.
   */
  markAwaitingPermission(
    taskID: string,
    input: { tool: string; permissionID?: string; now?: number },
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    const tool = normalizeWhitespace(input.tool);
    if (!tool) return existing;
    const at = input.now ?? Date.now();
    if (
      existing.awaitingPermission?.tool === tool &&
      existing.awaitingPermission.permissionID === input.permissionID
    ) {
      return existing;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      awaitingPermission: {
        tool,
        at,
        ...(input.permissionID ? { permissionID: input.permissionID } : {}),
      },
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  /**
   * Drop the permission stamp.
   *
   * `permissionID` fences the clear: a reply to an older, superseded prompt
   * must not unstamp the one that is currently open. A reply with no id (or a
   * record stamped before ids were observed) clears unconditionally, because
   * the alternative is a stamp nothing can remove.
   */
  clearAwaitingPermission(
    taskID: string,
    options: { permissionID?: string } = {},
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing?.awaitingPermission) return existing;
    const stamped = existing.awaitingPermission.permissionID;
    if (
      options.permissionID !== undefined &&
      stamped !== undefined &&
      stamped !== options.permissionID
    ) {
      return existing;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      awaitingPermission: undefined,
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  /**
   * Attribute an already-recorded outcome to a user `omo lanes stop`.
   *
   * Label only — the state, summary and reconciliation flags are untouched, so
   * an aborted child stays the `error` record its lifecycle produced and
   * remains revivable in place (`isReviveableRetainedJob`).
   *
   * Refused when the orchestrator's own cancellation path owns this run
   * (`cancellationRequested`, set under a cancellation lease by
   * `task_cancel`/`task_revive`): that outcome is already explained, and
   * double-labelling it would credit the user with a cancel the model asked
   * for.
   */
  markCancelledByUser(
    taskID: string,
    reason?: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (existing.cancellationRequested) return existing;
    if (existing.cancelledByUser !== undefined) return existing;

    const trimmed = reason ? normalizeWhitespace(reason) : '';
    const updated: BackgroundJobRecord = {
      ...existing,
      cancelledByUser: { at: now, ...(trimmed ? { reason: trimmed } : {}) },
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  /** Store partial work from a probe without asserting anything about state. */
  recordProgress(
    taskID: string,
    progress: LaneProgress,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    const updated: BackgroundJobRecord = {
      ...existing,
      lastProgress: progress,
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  /**
   * The host reports that this child no longer executes, but no native task
   * result established success, cancellation, or failure. Keep that ambiguity
   * visible to the parent and never permit session reuse.
   */
  markStopped(
    taskID: string,
    resultSummary: string,
    observedAt = Date.now(),
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (existing.deadlineExceededAt !== undefined) return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    if (
      existing.lastLiveBusyAt !== undefined &&
      existing.lastLiveBusyAt >= observedAt
    ) {
      return existing;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'stopped',
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      resultSummary,
      lastStatusError: undefined,
      silenceDetectedAt: undefined,
      silenceReason: undefined,
      awaitingPermission: undefined,
      stopConfirmationStartedAt: undefined,
    };
    this.jobs.set(taskID, updated);
    this.notifyTerminalStateListeners(taskID);
    return updated;
  }

  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    if (existing.stopConfirmationStartedAt !== undefined) return existing;

    const updated: BackgroundJobRecord = {
      ...existing,
      stopConfirmationStartedAt: startedAt,
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.state !== 'running') return existing;
    if (
      expectedGeneration !== undefined &&
      existing.generation !== expectedGeneration
    ) {
      return existing;
    }
    const updated: BackgroundJobRecord = {
      ...existing,
      statusUncertain: true,
      lastStatusError,
      updatedAt: now,
    };
    this.jobs.set(taskID, updated);
    return updated;
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      !existing.terminalUnreconciled &&
      !isCanonicalTerminalState(existing.state)
    ) {
      return undefined;
    }

    if (existing.state === 'stopped') {
      const updated: BackgroundJobRecord = {
        ...existing,
        terminalUnreconciled: false,
        statusUncertain: false,
        updatedAt: now,
        lastUsedAt: now,
      };
      this.jobs.set(taskID, updated);
      return updated;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'reconciled',
      terminalUnreconciled: false,
      statusUncertain:
        existing.deadlineExceededAt !== undefined
          ? existing.statusUncertain
          : false,
      updatedAt: now,
      lastUsedAt: now,
      terminalState: existing.terminalState ?? terminalStateOf(existing.state),
    };

    this.jobs.set(taskID, updated);
    this.trimReusable(taskID);
    return updated;
  }

  markCancelled(
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: {
      force?: boolean;
      expectedGeneration?: number;
      cancellationLease?: BackgroundJobLease;
    } = {},
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      options.expectedGeneration !== undefined &&
      existing.generation !== options.expectedGeneration
    ) {
      return existing;
    }
    const activeLease = this.liveLeases.get(taskID);
    if (
      options.cancellationLease !== undefined &&
      (options.cancellationLease.kind !== 'cancellation' ||
        !this.validateLease(options.cancellationLease))
    ) {
      return existing;
    }
    if (
      activeLease !== undefined &&
      (activeLease.kind !== 'cancellation' ||
        options.cancellationLease === undefined ||
        !this.validateLease(options.cancellationLease))
    ) {
      return existing;
    }
    if (existing.deadlineExceededAt !== undefined) {
      if (existing.state !== 'running') return existing;
      return this.finalizeWallClockTimeout({
        taskID,
        generation: existing.generation,
        now,
        statusUncertain: false,
        resultSummary: existing.resultSummary ?? normalizeCancelReason(reason),
      });
    }
    if (!options.force) {
      if (existing.state === 'reconciled') return existing;
      if (isCanonicalTerminalState(existing.state)) return existing;
    }

    const notifyTerminal =
      !isCanonicalTerminalState(existing.state) &&
      existing.state !== 'reconciled';
    const summary = normalizeCancelReason(reason);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'cancelled',
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: true,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: 'cancelled',
      resultSummary: summary,
      lastStatusError: undefined,
      silenceDetectedAt: undefined,
      silenceReason: undefined,
      awaitingPermission: undefined,
      stopConfirmationStartedAt: undefined,
    };

    this.jobs.set(taskID, updated);
    if (notifyTerminal) this.notifyTerminalStateListeners(taskID);
    return updated;
  }

  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (
      existing?.generation !== generation ||
      existing.state !== 'running' ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('cancellation'),
      kind: 'cancellation',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (existing?.generation !== generation || this.liveLeases.has(taskID)) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('relaunch'),
      kind: 'relaunch',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    if (
      existing?.generation !== generation ||
      existing.state !== 'running' ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('message'),
      kind: 'message',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    const existing = this.jobs.get(taskID);
    const terminal =
      existing?.state === 'completed' ||
      existing?.state === 'error' ||
      (existing?.state === 'reconciled' &&
        (existing.terminalState === 'completed' ||
          existing.terminalState === 'error'));
    if (
      existing?.generation !== generation ||
      !terminal ||
      this.liveLeases.has(taskID)
    ) {
      return undefined;
    }
    const lease: BackgroundJobLease = {
      taskID,
      generation,
      token: this.nextLeaseToken('terminal-notification'),
      kind: 'terminal-notification',
    };
    this.liveLeases.set(taskID, lease);
    return lease;
  }

  validateLease(lease: BackgroundJobLease): boolean {
    const activeLease = this.liveLeases.get(lease.taskID);
    return (
      activeLease?.token === lease.token &&
      activeLease.generation === lease.generation &&
      activeLease.kind === lease.kind
    );
  }

  releaseLease(lease: BackgroundJobLease): boolean {
    if (!this.validateLease(lease)) return false;
    this.liveLeases.delete(lease.taskID);
    return true;
  }

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.jobs.get(taskID);
  }

  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined {
    return this.get(taskID)?.[key];
  }

  isRunning(taskID: string): boolean {
    const job = this.get(taskID);
    return job?.state === 'running';
  }

  isTerminalUnreconciled(taskID: string): boolean {
    const job = this.get(taskID);
    return !!job?.terminalUnreconciled;
  }

  getResultSummary(taskID: string): string | undefined {
    return this.field(taskID, 'resultSummary');
  }

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.field(taskID, 'lastLiveBusyAt');
  }

  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (
      existing?.state !== 'running' ||
      existing?.generation !== input.generation ||
      existing?.deadlineExceededAt !== undefined
    ) {
      return undefined;
    }

    const now = input.now ?? Date.now();
    const updated: BackgroundJobRecord = {
      ...existing,
      timedOut: true,
      deadlineExceededAt: now,
      cancellationRequested: true,
      statusUncertain: false,
      updatedAt: now,
      resultSummary:
        input.resultSummary ??
        'Background task exceeded its wall-clock deadline; abort requested.',
    };
    this.jobs.set(input.taskID, updated);
    return updated;
  }

  finalizeWallClockTimeout(
    input: WallClockTimeoutFinalizeInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;
    if (existing.state !== 'running') return existing;
    if (
      existing.generation !== input.generation ||
      existing.deadlineExceededAt === undefined
    ) {
      return undefined;
    }

    const now = input.now ?? Date.now();
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'error',
      timedOut: true,
      recoverableAfterLiveBusy: false,
      statusUncertain: input.statusUncertain,
      cancellationRequested: true,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: 'error',
      resultSummary: input.resultSummary,
      lastStatusError: input.statusUncertain
        ? input.resultSummary
        : existing.lastStatusError,
      timeoutCount: (existing.timeoutCount ?? 0) + 1,
      lastErrorAt: now,
      totalErrors: (existing.totalErrors ?? 0) + 1,
      silenceDetectedAt: undefined,
      silenceReason: undefined,
      awaitingPermission: undefined,
      stopConfirmationStartedAt: undefined,
    };
    this.jobs.set(input.taskID, updated);
    this.notifyTerminalStateListeners(input.taskID);
    return updated;
  }

  getParentSessionID(taskID: string): string | undefined {
    return this.field(taskID, 'parentSessionID');
  }

  getState(taskID: string): BackgroundJobState | undefined {
    return this.field(taskID, 'state');
  }

  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined {
    const value = taskIDOrAlias.trim();
    return this.list(parentSessionID).find(
      (job) => job.taskID === value || job.alias === value,
    );
  }

  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job || !isReusable(job, this.maxContextLines)) return undefined;
    if (agent && job.agent !== agent) return undefined;
    return job;
  }

  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job) return undefined;
    if (agent && job.agent !== agent) return undefined;
    if (
      job.state !== 'running' ||
      !job.recoverableAfterLiveBusy ||
      job.deadlineExceededAt !== undefined
    ) {
      return undefined;
    }
    return job;
  }

  markUsed(parentSessionID: string, key: string, now = Date.now()): void {
    const job = this.resolve(parentSessionID, key);
    if (!job) return;
    // A use must land strictly after the job's completion so the
    // duplicate-spawn guard's escape hatch opens even when the retrieval and
    // the terminal transition share a millisecond.
    const usedAt =
      job.completedAt === undefined ? now : Math.max(now, job.completedAt + 1);
    this.jobs.set(job.taskID, {
      ...job,
      lastUsedAt: usedAt,
      updatedAt: now,
    });
  }

  taskIDs(): Set<string> {
    return new Set(this.jobs.keys());
  }

  addContext(taskID: string, files: ContextFile[]): void {
    if (files.length === 0) return;
    const job = this.jobs.get(taskID);
    if (!job) return;
    const existing = new Map(job.contextFiles.map((file) => [file.path, file]));
    for (const file of files) {
      const previous = existing.get(file.path);
      if (previous) {
        existing.set(file.path, {
          ...previous,
          lineCount: Math.max(previous.lineCount, file.lineCount),
          lastReadAt: Math.max(previous.lastReadAt, file.lastReadAt),
        });
      } else {
        existing.set(file.path, { ...file });
      }
    }
    const contextFiles = [...existing.values()]
      .filter((file) => file.lineCount >= this.readContextMinLines)
      .sort(
        (a, b) =>
          b.lineCount - a.lineCount ||
          b.lastReadAt - a.lastReadAt ||
          a.path.localeCompare(b.path),
      )
      .slice(0, this.readContextMaxFiles + 1);
    this.jobs.set(taskID, { ...job, contextFiles });
  }

  list(parentSessionID?: string): BackgroundJobRecord[] {
    const jobs = [...this.jobs.values()];
    const filtered = parentSessionID
      ? jobs.filter((job) => job.parentSessionID === parentSessionID)
      : jobs;

    return filtered.sort((a, b) => a.launchedAt - b.launchedAt);
  }

  hasRunning(parentSessionID: string): boolean {
    return this.list(parentSessionID).some((job) => job.state === 'running');
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.list(parentSessionID).some((job) => job.terminalUnreconciled);
  }

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    const job = this.jobs.get(taskID);
    if (!job) return false;
    const errors = job.totalErrors ?? 0;
    const timeouts = job.timeoutCount ?? 0;
    return errors >= threshold || timeouts >= threshold;
  }

  formatForPromptWithMetadata(
    parentSessionID: string,
    _now?: number,
  ): BackgroundJobPromptMetadata | undefined {
    const jobs = this.list(parentSessionID);
    const active = jobs.filter(
      (job) => job.state === 'running' || job.terminalUnreconciled,
    );
    const reusable = jobs.filter((j) => isReusable(j, this.maxContextLines));
    const acknowledgedFailedSession = reusable.some((job) => {
      const terminal = job.terminalState ?? terminalStateOf(job.state);
      return terminal === 'cancelled' || terminal === 'error';
    });

    if (active.length === 0 && reusable.length === 0) return undefined;

    const text = formatSystemReminder(
      [
        '### Background Job Board',
        'SENTINEL: background-job-board-v2',
        ...(acknowledgedFailedSession
          ? [
              'Acknowledged terminal sessions are reusable by alias for the same specialist/context.',
            ]
          : [
              'Completed or reconciled sessions are reusable by alias for the same specialist/context.',
            ]),
        'Timed-out running sessions are recoverable by alias for safe resume after a live busy signal.',
        ...(acknowledgedFailedSession
          ? [
              'Active, uncertain, or unacknowledged terminal sessions are not reusable.',
            ]
          : ['Cancelled or errored sessions are not reusable.']),
        '',
        '#### Active / Unreconciled',
        ...(active.length > 0 ? active.map(formatJob) : ['- none']),
        '',
        '#### Reusable Sessions',
        ...(reusable.length > 0
          ? reusable.map((job) => this.formatReusableJob(job))
          : ['- none']),
      ].join('\n'),
    );

    const terminalUnreconciledTaskIDs = active
      .filter((job) => job.terminalUnreconciled)
      .map(({ taskID, generation }) => ({ taskID, generation }));

    return { text, terminalUnreconciledTaskIDs };
  }

  formatForPrompt(parentSessionID: string, now?: number): string | undefined {
    return this.formatForPromptWithMetadata(parentSessionID, now)?.text;
  }

  clearParent(parentSessionID: string): void {
    for (const job of this.list(parentSessionID)) {
      recordBackgroundJobSuppression(this, job.taskID);
      this.jobs.delete(job.taskID);
    }
  }

  drop(taskID: string): void {
    recordBackgroundJobSuppression(this, taskID);
    this.jobs.delete(taskID);
  }

  // ── Lifecycle policy (board = no policy, always close) ───────────

  deferIfRunning(_sessionId: string): boolean {
    return false; // ponytail: safe default - don't close
  }

  retryDeferredClose(_sessionId: string): boolean {
    return false; // Nothing deferred at board level
  }

  clearDeferredClose(_sessionId: string): void {
    // No-op at board level
  }

  private trimReusable(taskID: string): void {
    const job = this.jobs.get(taskID);
    if (!job) return;

    // Evict sessions exceeding context budget before count cap.
    // Runs regardless of the triggering job's reusability so that a
    // bloated session cleans up after itself (and its peers) on
    // completion.
    for (const entry of this.list(job.parentSessionID)) {
      if (
        entry.agent === job.agent &&
        !entry.terminalUnreconciled &&
        (entry.terminalState ?? terminalStateOf(entry.state)) !== undefined &&
        sumContextLines(entry) > this.maxContextLines
      ) {
        recordBackgroundJobSuppression(this, entry.taskID);
        this.jobs.delete(entry.taskID);
      }
    }

    // Only apply the count cap when the triggering job is reusable
    if (!isReusable(job, this.maxContextLines)) return;

    const reusable = this.list(job.parentSessionID)
      .filter(
        (candidate) =>
          candidate.agent === job.agent &&
          isReusable(candidate, this.maxContextLines),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const stale of reusable.slice(this.maxReusablePerAgent)) {
      recordBackgroundJobSuppression(this, stale.taskID);
      this.jobs.delete(stale.taskID);
    }
  }

  private formatReusableJob(job: BackgroundJobRecord): string {
    const terminal = job.terminalState ?? terminalStateOf(job.state);
    const reconciliation = job.terminalUnreconciled
      ? 'unreconciled'
      : 'reconciled';
    const lines = [
      `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(terminal ?? job.state)}, ${reconciliation}`,
      `  Objective: ${promptSafe(job.description || job.objective || '')}`,
    ];
    const context = formatContextFiles(
      job.contextFiles,
      this.readContextMaxFiles,
    );
    if (context) lines.push(`  Context read by ${job.alias}: ${context}`);
    return lines.join('\n');
  }

  private nextAlias(parentSessionID: string, agent: string): string {
    const prefix = AGENT_PREFIX[agent] ?? (agent.slice(0, 3) || 'job');
    const key = `${parentSessionID}:${prefix}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    return `${prefix}-${next}`;
  }

  private nextLeaseToken(kind: BackgroundJobLeaseKind): string {
    this.leaseSequence += 1;
    return `background-job-${kind}-lease-${this.leaseSequence}`;
  }
}

export function deriveTaskSessionLabel(input: {
  description?: string;
  prompt?: string;
  agentType: string;
}): string {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred.slice(0, 48);
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine
    ? firstPromptLine.slice(0, 48)
    : `recent ${input.agentType} task`;
}
/**
 * Full objective text before deriveTaskSessionLabel truncates it: the
 * whitespace-normalized description, else the first non-empty prompt line.
 * Board records store this untruncated so the duplicate-spawn guard can
 * match long exact duplicates without colliding on shared 48-char prefixes.
 */
export function deriveFullObjective(input: {
  description?: string;
  prompt?: string;
}): string | undefined {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred;
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine ?? undefined;
}

function sumContextLines(record: BackgroundJobRecord): number {
  return record.contextFiles.reduce((sum, f) => sum + (f.lineCount ?? 0), 0);
}

function isReusable(
  job: BackgroundJobRecord,
  maxContextLines: number,
): boolean {
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  if (
    terminal === undefined ||
    job.terminalUnreconciled ||
    job.statusUncertain
  ) {
    return false;
  }

  return sumContextLines(job) <= maxContextLines;
}

function terminalStateOf(
  state: BackgroundJobState,
): TaskOutputState | undefined {
  return state === 'completed' || state === 'error' || state === 'cancelled'
    ? state
    : undefined;
}

function isCanonicalTerminalState(
  state: BackgroundJobState,
): state is TaskOutputState {
  return CANONICAL_TERMINAL_STATES.has(state as TaskOutputState);
}

function formatContextFiles(files: ContextFile[], maxFiles: number): string {
  if (maxFiles === 0) return '';
  const shown = files.slice(0, maxFiles);
  const rest = files.length - shown.length;
  const rendered = shown.map(
    (file) => `${promptSafe(file.path)} (${file.lineCount} lines)`,
  );
  return `${rendered.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function timeoutSummary(state: TaskOutputState): string {
  return `Background task exceeded its wall-clock deadline; abort was observed with child state ${state}.`;
}

function formatJob(job: BackgroundJobRecord): string {
  const isResume = job.lastLaunchedAt !== job.launchedAt;
  // Exclude wall-clock age labels so prompts remain stable between job-state transitions for cache reuse.
  const displayState =
    job.state === 'running' && isResume ? 'running [resumed]' : job.state;
  const status = job.terminalUnreconciled
    ? `${job.state}, unreconciled${
        job.deadlineExceededAt !== undefined ? ', timed out' : ''
      }`
    : job.statusUncertain
      ? `${job.state}, status uncertain`
      : job.timedOut
        ? `${job.state}, timed out`
        : displayState;
  const lines = [
    `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(status)}`,
    `  Objective: ${promptSafe(job.description || job.objective || '')}`,
  ];

  if (job.resultSummary && job.terminalUnreconciled) {
    lines.push(`  Result: ${promptSafe(job.resultSummary)}`);
  } else if (job.lastStatusError && job.statusUncertain) {
    lines.push(`  Status: ${promptSafe(job.lastStatusError)}`);
  }

  const waiting = formatAwaitingPermission(job);
  if (waiting) lines.push(waiting);

  const userStop = formatUserStop(job);
  if (userStop) lines.push(...userStop);

  const lastSeen = formatLastSeen(job);
  if (lastSeen) lines.push(lastSeen);

  return lines.join('\n');
}

/**
 * Why a live lane is quiet: a human has not answered its permission prompt.
 *
 * Only the tool name is rendered — no timestamp, no age — so a lane parked on
 * the same prompt renders byte-identically on every injection.
 */
function formatAwaitingPermission(
  job: BackgroundJobRecord,
): string | undefined {
  if (job.state !== 'running') return undefined;
  const waiting = job.awaitingPermission;
  return waiting
    ? `  Waiting: permission for ${promptSafe(waiting.tool)}`
    : undefined;
}

/**
 * Attribute a terminal record to the user's own `omo lanes stop`.
 *
 * The label is advisory (an intent line can be lost or, in theory, reused), so
 * the text never contradicts the state — it explains who ended the run and
 * what the orchestrator should do about it. Frozen reason text only; nothing
 * here is derived from the clock.
 */
function formatUserStop(job: BackgroundJobRecord): string[] | undefined {
  const stop = job.cancelledByUser;
  if (!stop) return undefined;
  const reason = stop.reason ? `: ${promptSafe(stop.reason)}` : '';
  return [
    `  Stopped by: the user, from a second terminal (omo lanes stop)${reason}`,
    '  Action: treat this as a user cancellation - do not relaunch it unasked; its session is intact, so task_revive(task_id) resumes it if the user asks.',
  ];
}

/**
 * What a flagged-silent lane was last doing.
 *
 * Rendered from the stored probe only — no wall-clock age, no `capturedAt`,
 * nothing derived from "now". Two renders of an unchanged lane must be
 * byte-identical or every board injection busts the provider prompt cache.
 */
function formatLastSeen(job: BackgroundJobRecord): string | undefined {
  if (job.state !== 'running' || !job.statusUncertain) return undefined;
  const progress = job.lastProgress;
  if (!progress) return undefined;

  const detail = [
    ...(progress.lastTool
      ? [
          `last tool: ${promptSafe(progress.lastTool.name)} ${promptSafe(
            progress.lastTool.status,
          )}`,
        ]
      : []),
    `${progress.messageCount} msg${progress.messageCount === 1 ? '' : 's'}`,
  ].join(', ');
  const text = progress.text
    ? promptSafe(progress.text)
    : 'no assistant output yet';

  return `  Last seen: ${text} (${detail})`;
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

function promptSafe(value: string): string {
  return singleLine(value)
    .replaceAll('\\', '/')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeCancelReason(reason?: string): string {
  const normalized = reason?.replace(/\s+/g, ' ').trim();
  return normalized ? `cancelled: ${normalized}` : 'cancelled';
}
