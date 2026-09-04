/**
 * Event router for task session manager.
 *
 * Routes lifecycle events (session.created, server.instance.disposed,
 * session.idle, session.error, session.status, session.deleted) to
 * the appropriate subsystems.
 */
import type { BackgroundJobExecution } from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import { isReviveableRetainedJob } from '../../utils/lane-state';
import { log } from '../../utils/logger';
import {
  isAbortedSessionError,
  isTransportError,
  sessionErrorMessage,
  transportSessionErrorReason,
} from '../../utils/session-error';
import {
  isFailoverError,
  isInlineFailoverError,
} from '../foreground-fallback/index';
import type {
  InjectedTerminalJobs,
  RetainedBoardSnapshotState,
} from './board-injection';
import { CASCADE_WINDOW_MS, type CascadeTracker } from './cascade-attribution';
import type {
  EarlyTaskRegistration,
  PendingTaskCall,
} from './pending-call-tracker';
import type { RevivedRunTracker } from './revived-run-tracker';

type BackgroundJobRecord = NonNullable<ReturnType<BackgroundJobStore['get']>>;

interface SessionEventGenerationFence {
  generation: number;
  /** A new generation must see a live activity fence before lifecycle events. */
  awaitingActivity: boolean;
}

interface SessionEventObservation {
  sessionID: string;
  job?: BackgroundJobRecord;
  generation?: number;
  observedAt: number;
  stale: boolean;
  /** Busy establishes the new local fence but does not mutate the board. */
  activityFenceOnly: boolean;
}

/**
 * OpenCode's v1 lifecycle events do not carry a run generation or a CAS token.
 * Keep the strongest local fence available: a board generation transition
 * quarantines the first unproven lifecycle sequence, while explicit host
 * provenance/timestamps (when present) are checked against the current run.
 * This cannot prove the origin of a same-ID event after the host has omitted
 * that provenance; callers must not treat this as remote atomicity.
 */
const sessionEventFences = new WeakMap<
  object,
  Map<string, SessionEventGenerationFence>
>();

function eventFenceMap(
  backgroundJobBoard: BackgroundJobStore,
): Map<string, SessionEventGenerationFence> {
  const key = backgroundJobBoard as object;
  const existing = sessionEventFences.get(key);
  if (existing) return existing;
  const created = new Map<string, SessionEventGenerationFence>();
  sessionEventFences.set(key, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function eventGeneration(input: {
  event: { properties?: Record<string, unknown> };
}): number | undefined {
  const properties = input.event.properties;
  const info = isRecord(properties?.info) ? properties.info : undefined;
  const direct = properties?.generation;
  if (finiteNumber(direct)) return direct;
  return finiteNumber(info?.generation) ? info.generation : undefined;
}

function eventActivityAt(
  input: { event: { properties?: Record<string, unknown> } },
  fallback: number,
): number {
  const properties = input.event.properties;
  const info = isRecord(properties?.info) ? properties.info : undefined;
  const infoTime = isRecord(info?.time) ? info.time : undefined;
  const directCandidates = [
    properties?.activityAt,
    properties?.timestamp,
    properties?.time,
    info?.activityAt,
    info?.timestamp,
    infoTime?.updated,
  ];
  const observed = directCandidates.find(finiteNumber);
  return observed === undefined ? fallback : observed;
}

function rememberSessionGeneration(
  backgroundJobBoard: BackgroundJobStore,
  sessionID: string,
): void {
  const job = backgroundJobBoard.get(sessionID);
  if (!job) return;
  const fences = eventFenceMap(backgroundJobBoard);
  const previous = fences.get(sessionID);
  if (!previous || previous.generation !== job.generation) {
    fences.set(sessionID, {
      generation: job.generation,
      awaitingActivity: previous !== undefined,
    });
  }
}

function observeSessionEvent(
  backgroundJobBoard: BackgroundJobStore,
  input: { event: { properties?: Record<string, unknown> } },
  sessionID: string,
  observedAt: number,
  isBusy: boolean,
): SessionEventObservation {
  const job = backgroundJobBoard.get(sessionID);
  if (!job) {
    eventFenceMap(backgroundJobBoard).delete(sessionID);
    return {
      sessionID,
      observedAt,
      stale: false,
      activityFenceOnly: false,
    };
  }

  const fences = eventFenceMap(backgroundJobBoard);
  const previous = fences.get(sessionID);
  const generationChanged =
    previous !== undefined && previous.generation !== job.generation;
  const fence = generationChanged
    ? {
        generation: job.generation,
        awaitingActivity: true,
      }
    : (previous ?? {
        generation: job.generation,
        awaitingActivity: false,
      });
  fences.set(sessionID, fence);

  const suppliedGeneration = eventGeneration(input);
  const suppliedCurrentGeneration =
    suppliedGeneration !== undefined && suppliedGeneration === job.generation;
  const activityIsBeforeRun = observedAt < job.runStartedAt;
  const activityIsBeforeCurrentBusy =
    job.lastLiveBusyAt !== undefined && job.lastLiveBusyAt > observedAt;
  const stale =
    (suppliedGeneration !== undefined && !suppliedCurrentGeneration) ||
    activityIsBeforeRun ||
    activityIsBeforeCurrentBusy ||
    (fence.awaitingActivity && !isBusy && !suppliedCurrentGeneration);

  // A host event without provenance can only establish a local activity
  // boundary. Do not let that first post-relaunch busy observation mutate G2;
  // a later event runs after the boundary has been established.
  const activityFenceOnly =
    !stale && fence.awaitingActivity && isBusy && !suppliedCurrentGeneration;
  if (!stale && (activityFenceOnly || suppliedCurrentGeneration)) {
    fence.awaitingActivity = false;
  }

  return {
    sessionID,
    job,
    generation: job.generation,
    observedAt,
    stale,
    activityFenceOnly,
  };
}

/**
 * How long a revived lane's parent notification waits after an abort.
 *
 * The cascade window plus a margin: an abort's CAUSE arrives after the abort
 * itself (the parent's own `session.error` lands ~100ms later, and an idle
 * confirmation later still), so a notification sent on the abort event is
 * guaranteed to render before the attribution exists. 300ms of slack covers
 * the confirming event plus the synchronous `markCascade` behind it.
 */
export const NOTIFICATION_CASCADE_DEFER_MS = CASCADE_WINDOW_MS + 300;

/**
 * Events that prove a child session is still producing output.
 *
 * `message.part.delta` is the important one: during a long streamed reply it
 * is the ONLY event a healthy lane emits, so a heartbeat without it would flag
 * every slow-but-working lane as frozen (Gate-2 M1).
 */
const ACTIVITY_EVENT_TYPES = new Set([
  'message.part.delta',
  'message.part.updated',
  'message.updated',
]);

/**
 * Session id carried by an activity event, across the three shapes OpenCode
 * uses: `properties.sessionID` (delta), `properties.part.sessionID`
 * (part.updated) and `properties.info.sessionID` (message.updated).
 */
function activityEventSessionID(input: {
  event: { properties?: Record<string, unknown> };
}): string | undefined {
  const properties = input.event.properties;
  if (!properties) return undefined;
  const direct = properties.sessionID;
  if (typeof direct === 'string' && direct) return direct;
  const part = isRecord(properties.part) ? properties.part : undefined;
  if (typeof part?.sessionID === 'string' && part.sessionID) {
    return part.sessionID;
  }
  const info = isRecord(properties.info) ? properties.info : undefined;
  return typeof info?.sessionID === 'string' && info.sessionID
    ? info.sessionID
    : undefined;
}

/**
 * How many injected user-message ids to remember per lane.
 *
 * Only enough to cover the part events of the messages an operator could have
 * pushed into one silence window; the set is per lane and cleared on session
 * deletion, so it cannot grow with session count either.
 */
const INJECTED_USER_MESSAGE_MEMORY = 8;

/**
 * Per-board memory of user messages written INTO a lane rather than produced
 * by it, keyed the same way as the generation fences.
 */
const injectedUserMessages = new WeakMap<object, Map<string, Set<string>>>();

function injectedUserMessageMap(
  backgroundJobBoard: BackgroundJobStore,
): Map<string, Set<string>> {
  const key = backgroundJobBoard as object;
  const existing = injectedUserMessages.get(key);
  if (existing) return existing;
  const created = new Map<string, Set<string>>();
  injectedUserMessages.set(key, created);
  return created;
}

/** Message id an activity event belongs to, across the three event shapes. */
function activityEventMessageID(input: {
  event: { type: string; properties?: Record<string, unknown> };
}): string | undefined {
  const properties = input.event.properties;
  if (!properties) return undefined;
  if (input.event.type === 'message.updated') {
    const info = isRecord(properties.info) ? properties.info : undefined;
    return typeof info?.id === 'string' && info.id ? info.id : undefined;
  }
  const direct = properties.messageID;
  if (typeof direct === 'string' && direct) return direct;
  const part = isRecord(properties.part) ? properties.part : undefined;
  return typeof part?.messageID === 'string' && part.messageID
    ? part.messageID
    : undefined;
}

/**
 * True when this activity event describes a message written INTO the lane
 * instead of output produced BY it.
 *
 * `task_message` (and the planned `omos lanes say`) prompt a child directly,
 * which makes the host emit `message.updated` for the new user message plus
 * part events for its text. Counting those as lane activity would let an
 * operator poking a frozen child silently clear its silence flag and buy it
 * another full silence window — the exact opposite of what asking a hung lane
 * a question should do. The lane's own reply carries a different message id
 * and still counts, so a lane that genuinely wakes up is revived normally.
 */
function isInjectedUserMessageEvent(
  backgroundJobBoard: BackgroundJobStore,
  input: { event: { type: string; properties?: Record<string, unknown> } },
  sessionID: string,
): boolean {
  const messageID = activityEventMessageID(input);
  if (input.event.type === 'message.updated') {
    const info = isRecord(input.event.properties?.info)
      ? input.event.properties.info
      : undefined;
    if (info?.role !== 'user') return false;
    if (messageID) {
      const byLane = injectedUserMessageMap(backgroundJobBoard);
      const known = byLane.get(sessionID) ?? new Set<string>();
      known.add(messageID);
      // Bounded FIFO: Set preserves insertion order.
      while (known.size > INJECTED_USER_MESSAGE_MEMORY) {
        const oldest = known.values().next();
        if (oldest.done) break;
        known.delete(oldest.value);
      }
      byLane.set(sessionID, known);
    }
    return true;
  }

  if (!messageID) return false;
  return (
    injectedUserMessageMap(backgroundJobBoard)
      .get(sessionID)
      ?.has(messageID) === true
  );
}

/**
 * Permission events that arm the HITL stamp on a lane.
 *
 * `permission.asked` is the real, in-process name: plugins receive core's own
 * event bus, where the ask is
 * `{ type: 'permission.asked', properties: { id, sessionID, permission,
 * patterns, metadata, always, tool? } }` (this is also the shape upstream's
 * `input-wait-tracker` matches, correctly). The published SDK event union
 * instead describes the HTTP `/event` stream, which translates the ask into
 * `permission.updated` with a `type`/`title` payload. Both names and both
 * payload shapes are accepted here rather than betting on one transport.
 */
const PERMISSION_ASK_EVENTS = new Set([
  'permission.asked',
  'permission.updated',
]);

/** Events that resolve a permission prompt (reply, rejection, cancellation). */
const PERMISSION_RESOLVE_EVENTS = new Set([
  'permission.replied',
  'permission.rejected',
  'permission.cancelled',
]);

/** Permission names are plain identifiers (`bash`, `edit`, `webfetch`). */
const PERMISSION_TOOL_PATTERN = /^[\w.:-]{1,40}$/;

/**
 * What the lane is asking permission for.
 *
 * Candidate order follows the transports: `permission` is core's in-process
 * field (and the one that actually reaches a plugin), `type` is the SDK/HTTP
 * translation of the same value, and `title` is the human sentence used only
 * when neither names the tool. Truncated because it is rendered into the
 * board.
 */
function permissionToolName(properties: unknown): string | undefined {
  const props = isRecord(properties) ? properties : undefined;
  const candidates = [props?.permission, props?.type, props?.title];
  const named: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (PERMISSION_TOOL_PATTERN.test(trimmed)) return trimmed;
    named.push(trimmed);
  }
  const fallback = named[0];
  return fallback ? fallback.slice(0, 60) : undefined;
}

/**
 * Permission request id, across the spellings the two transports use.
 *
 * Core's reply carries `requestID` (`{ sessionID, requestID, reply }`); the
 * SDK's `permission.replied` carries `permissionID`. The ask carries `id` in
 * both. Order matters: reading the wrong field yields `undefined`, which would
 * clear a stamp the reply did not answer.
 */
function permissionRequestID(
  properties: unknown,
  kind: 'ask' | 'resolve',
): string | undefined {
  const props = isRecord(properties) ? properties : undefined;
  const candidates =
    kind === 'ask'
      ? [props?.id, props?.permissionID, props?.requestID]
      : [props?.requestID, props?.permissionID, props?.id];
  const found = candidates.find(
    (value) => typeof value === 'string' && value.length > 0,
  );
  return typeof found === 'string' ? found : undefined;
}

function isCurrentSessionObservation(
  backgroundJobBoard: BackgroundJobStore,
  observation: SessionEventObservation,
): boolean {
  if (!observation.job || observation.generation === undefined) return true;
  const current = backgroundJobBoard.get(observation.sessionID);
  if (!current || current.generation !== observation.generation) return false;
  if (current.runStartedAt > observation.observedAt) return false;
  return !(
    current.lastLiveBusyAt !== undefined &&
    current.lastLiveBusyAt > observation.observedAt
  );
}

export async function handleEvent(
  input: {
    event: {
      type: string;
      properties?: {
        info?: {
          id?: string;
          parentID?: string;
          agent?: string;
          generation?: number;
          activityAt?: number;
          timestamp?: number;
          time?: { updated?: number };
        };
        id?: string;
        requestID?: string;
        sessionID?: string;
        generation?: number;
        activityAt?: number;
        timestamp?: number;
        time?: { updated?: number };
        status?: { type?: string };
        error?: { name?: string };
        part?: unknown;
      };
    };
  },
  deps: {
    inputWaits: {
      trackInputWait(event: {
        type: string;
        properties?: {
          id?: string;
          requestID?: string;
          sessionID?: string;
        };
      }): void;
      clearInputWaits(sessionID: string): void;
      waitsByParent: Map<string, Set<string | symbol>>;
    };
    idleSessionTokens: {
      clearSession(sessionID: string): void;
      invalidate(sessionID: string): void;
      /** Drop local idle-token bookkeeping; keep process-global wait_for_user. */
      disposeLocalState(): void;
      sessionTokens: Map<string, symbol>;
    };
    options: {
      shouldManageSession: (sessionID: string) => boolean;
      registerSessionAsOrchestrator?: (sessionID: string) => void;
      isFallbackInProgress?: (sessionID: string) => boolean;
      /** True when foreground fallback could still recover the session. */
      willAttemptFallback?: (sessionID: string) => boolean;
      /** Test seam; production uses event-arrival wall-clock time. */
      now?: () => number;
    };
    idleReconciler: {
      scheduleIdleReconciliation(sessionID: string): void;
      scheduleChildIdleReconciliation(
        sessionID: string,
        idleObservedAt: number,
        observedGeneration: number,
      ): void;
      scheduleErrorTerminalize(
        sessionID: string,
        idleObservedAt: number,
        observedGeneration: number,
      ): void;
      clearIdleTimers(sessionID: string): void;
      clearAllTimers(): string[];
    };
    /** Sessions with a deferred inline 401/410 awaiting fallback outcome. */
    deferredInlineErrors: Set<string>;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      peekByParentAndAgent(
        parentSessionID: string,
        agentHint?: string,
      ): PendingTaskCall | undefined;
      clearSession(sessionID: string): void;
      clearAll?(): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      clearSession(sessionID: string): void;
      prune(board: { taskIDs(): Set<string> }): void;
    };
    terminalJobsInjectedByParent: Map<string, InjectedTerminalJobs>;
    pendingInjectedTerminalJobsByParent: Map<
      string,
      Map<string, BackgroundJobExecution>
    >;
    retainedBoardSnapshots: Map<string, RetainedBoardSnapshotState>;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    bindConcurrencyTicket?: (taskID: string, pending: PendingTaskCall) => void;
    releaseConcurrencyTask?: (taskID: string) => void;
    observeSyntheticTerminalPart?: (part: unknown) => void;
    revivedRunTracker?: RevivedRunTracker;
    /**
     * Lane control: claim the `omos lanes stop` intent that explains an abort
     * of this lane, if the CLI wrote one in the last minute. Returns
     * `undefined` for the normal case (no user stop), and is absent entirely
     * when `backgroundJobs.laneControl` is off.
     */
    claimUserStopIntent?: (
      sessionID: string,
    ) => { reason?: string } | undefined;
    /**
     * Lane control: claim the `omos lanes revive` intent that explains a busy
     * signal on a settled lane. Absent when `backgroundJobs.laneControl` is
     * off.
     */
    claimUserReviveIntent?: (sessionID: string) => { at: number } | undefined;
    /**
     * Register the run `omos lanes revive` just started as a revived run, so
     * the parent gets the same synthesized `<task>` notification a
     * `task_revive` would have produced. Absent when lane control is off.
     */
    adoptRevivedRun?: (sessionID: string) => Promise<void>;
    /**
     * ESC attribution. Fed the three signals it needs from this router:
     * anonymous child aborts, orchestrator aborts, and managed-orchestrator
     * busy/idle transitions.
     */
    cascade?: CascadeTracker;
  },
): Promise<void> {
  deps.inputWaits.trackInputWait(input.event);

  // Heartbeat first, and before any early return: the activity clock backing
  // silence detection has to see event types this router otherwise ignores
  // (`message.part.delta`, `message.updated`) as well as the one it consumes
  // and returns from below. One board lookup; unknown sessions no-op.
  if (ACTIVITY_EVENT_TYPES.has(input.event.type)) {
    const activeSessionID = activityEventSessionID(input);
    if (
      activeSessionID &&
      !isInjectedUserMessageEvent(
        deps.backgroundJobBoard,
        input,
        activeSessionID,
      )
    ) {
      deps.backgroundJobBoard.recordActivity(
        activeSessionID,
        eventActivityAt(input, deps.options.now?.() ?? Date.now()),
      );
    }
  }

  if (input.event.type === 'message.part.updated') {
    deps.observeSyntheticTerminalPart?.(input.event.properties?.part);
    return;
  }

  // HITL seam for CHILD lanes. Upstream's input-wait tracker (consulted above)
  // reads the same events but is scoped to ORCHESTRATOR sessions
  // (`shouldManageSession`), so without this a lane parked on a permission
  // prompt looks identical to a frozen one: silence detection would eventually
  // flag it, and neither the board nor `omos lanes list` could say why it went
  // quiet. The stamp lives on the lane's own board record, so it needs no
  // second tracker and dies with the run.
  if (PERMISSION_ASK_EVENTS.has(input.event.type)) {
    const sessionID = input.event.properties?.sessionID;
    const tool = permissionToolName(input.event.properties);
    if (sessionID && tool) {
      const stamped = deps.backgroundJobBoard.markAwaitingPermission(
        sessionID,
        {
          tool,
          permissionID: permissionRequestID(input.event.properties, 'ask'),
          now: eventActivityAt(input, deps.options.now?.() ?? Date.now()),
        },
      );
      if (stamped?.awaitingPermission) {
        log('[task-session-manager] lane awaiting permission', {
          sessionID,
          alias: stamped.alias,
          tool: stamped.awaitingPermission.tool,
        });
      }
    }
    return;
  }

  if (PERMISSION_RESOLVE_EVENTS.has(input.event.type)) {
    const sessionID = input.event.properties?.sessionID;
    if (sessionID) {
      deps.backgroundJobBoard.clearAwaitingPermission(sessionID, {
        permissionID: permissionRequestID(input.event.properties, 'resolve'),
      });
    }
    return;
  }

  if (input.event.type === 'session.created') {
    const info = input.event.properties?.info;
    if (info?.id) deps.retainedBoardSnapshots.delete(info.id);
    if (info?.id) {
      rememberSessionGeneration(deps.backgroundJobBoard, info.id);
    }
    log('[task-session-manager] session.created observed', {
      sessionID: info?.id,
      parentSessionID: info?.parentID,
      managesParent: info?.parentID
        ? deps.options.shouldManageSession(info.parentID)
        : false,
    });
    if (
      info?.id &&
      info.parentID &&
      deps.options.shouldManageSession(info.parentID)
    ) {
      deps.taskContextTracker.pendingManagedTaskIds.add(info.id);
      // Early board registration: if the parent tool call is cancelled
      // before tool.execute.after (e.g. foreground fallback abort), the
      // after-hook never fires and the job is never tracked — idle then
      // reports runningJobForSession:false and the orchestrator sees
      // "Task cancelled" while the child is still working (#765).
      // Peek (don't take) so tool.execute.after can still re-register.
      //
      // When the parent has multiple task calls in flight at once (e.g.
      // parallel council reviewers), `info.agent` on the child session
      // identifies which subagent started it; prefer the matching
      // pending call so we don't attribute the child to the wrong agent.
      const pending = deps.pendingCallTracker.peekByParentAndAgent(
        info.parentID,
        info.agent,
      );
      if (pending && !pending.resumedTaskId && !pending.earlyRegisteredTaskID) {
        if (deps.backgroundJobBoard.get(info.id)) {
          pending.earlyRegistrationRejected = true;
          log(
            '[task-session-manager] refused early registration for an existing task ID',
            { taskID: info.id, parentSessionID: info.parentID },
          );
        } else {
          try {
            const record = deps.backgroundJobBoard.registerLaunch({
              taskID: info.id,
              parentSessionID: pending.parentSessionId,
              agent: pending.agentType,
              description: pending.label,
              objective: pending.fullObjective ?? pending.label,
              // session.created has no reliable call identity. Keep this
              // registration tentative so an unrelated foreground call cannot
              // accidentally arm wall-clock supervision.
              background: false,
            });
            pending.earlyRegisteredTaskID = record.taskID;
            pending.earlyRegistration = {
              taskID: record.taskID,
              generation: record.generation,
              backgroundJobBoard: deps.backgroundJobBoard,
              backgroundJobSupervisor: deps.backgroundJobSupervisor,
            } satisfies EarlyTaskRegistration;
            deps.bindConcurrencyTicket?.(record.taskID, pending);
            log(
              '[task-session-manager] tentative early board registration from session.created',
              {
                taskID: record.taskID,
                alias: record.alias,
                parentSessionID: record.parentSessionID,
                agent: record.agent,
              },
            );
          } catch (error) {
            pending.earlyRegistrationRejected = true;
            log(
              '[task-session-manager] refused fenced early registration from session.created',
              {
                taskID: info.id,
                parentSessionID: info.parentID,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }
    }
    return;
  }

  if (input.event.type === 'server.instance.disposed') {
    deps.backgroundJobSupervisor?.dispose();
    deps.revivedRunTracker?.dispose();
    deps.retainedBoardSnapshots.clear();
    eventFenceMap(deps.backgroundJobBoard).clear();
    injectedUserMessageMap(deps.backgroundJobBoard).clear();
    const idleSessionIds = deps.idleReconciler.clearAllTimers();
    // Local-only: drop idle tokens. Process-global wait_for_user stays armed.
    const waitSessionIDs = new Set([
      ...idleSessionIds,
      ...deps.idleSessionTokens.sessionTokens.keys(),
      ...deps.inputWaits.waitsByParent.keys(),
    ]);
    deps.idleSessionTokens.disposeLocalState();
    for (const sessionID of waitSessionIDs) {
      deps.inputWaits.clearInputWaits(sessionID);
    }
    return;
  }

  if (
    input.event.type === 'session.idle' ||
    (input.event.type === 'session.status' &&
      (input.event.properties as { status?: { type?: string } } | undefined)
        ?.status?.type === 'idle')
  ) {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          false,
        )
      : undefined;
    if (observation?.stale || observation?.activityFenceOnly) return;
    const job = observation?.job;
    log('[task-session-manager] idle/status idle observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      terminalJobsPending: sessionId
        ? (deps.terminalJobsInjectedByParent.get(sessionId)?.executions.size ??
            0) +
          (deps.pendingInjectedTerminalJobsByParent.get(sessionId)?.size ?? 0)
        : 0,
      runningJobForSession: job?.state === 'running' || false,
    });
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      // A managed orchestrator's idle is the B3 cascade signal: after ESC on
      // an ALREADY idle parent the host emits a redundant idle it has no other
      // reason to emit. Fed before reconciliation so the attribution is in
      // place by the time anything renders the board.
      deps.cascade?.noteOrchestratorIdle(sessionId);
      deps.idleReconciler.scheduleIdleReconciliation(sessionId);
    }

    // Fallback: for background child sessions that go idle without
    // an injected completion, reconcile the board entry since the
    // session being idle is itself the completion signal.
    // Delayed so FG can claim the session before we mark completed.
    if (job && sessionId && job.state === 'running') {
      if (deps.deferredInlineErrors.has(sessionId)) {
        // A persistent 401/410 was deferred for fallback recovery but the
        // session ended without one: terminalize as error instead of the
        // false completion the child-idle path would record.
        deps.idleReconciler.scheduleErrorTerminalize(
          sessionId,
          observedAt,
          job.generation,
        );
      } else {
        deps.idleReconciler.scheduleChildIdleReconciliation(
          sessionId,
          observedAt,
          job.generation,
        );
      }
    }
    return;
  }

  if (input.event.type === 'session.error') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          false,
        )
      : undefined;
    if (
      observation?.stale ||
      observation?.activityFenceOnly ||
      (observation &&
        !isCurrentSessionObservation(deps.backgroundJobBoard, observation))
    ) {
      return;
    }
    if (sessionId) {
      deps.idleSessionTokens.invalidate(sessionId);
    }
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      const props = input.event.properties as { error?: unknown } | undefined;
      // An abort of the orchestrator (probe B1) is the unambiguous half of the
      // two-sided cascade detection, and it confirms candidates recorded up to
      // 3s BEFORE it — the children are aborted first.
      //
      // Foreground fallback aborts the orchestrator the same way to swap
      // models, and it kills every lane just as thoroughly, so it is attributed
      // too — with its own CAUSE, because "the user pressed ESC" would be a
      // lie about the plugin's own recovery.
      if (isAbortedSessionError(props?.error)) {
        deps.cascade?.noteOrchestratorAbort(
          sessionId,
          deps.options.isFallbackInProgress?.(sessionId) ? 'fallback' : 'esc',
        );
      }
      // Only clear injected terminal jobs for fatal errors.
      // Rate-limit errors are recovered by ForegroundFallbackManager
      // (abort + reprompt with fallback model); clearing the injected
      // job state here would make the orchestrator lose track of
      // completed background tasks and unable to dispatch follow-ups.
      // Persistent 401/410 (auth, model gone) may ALSO be recovered by a
      // fallback reprompt, so defer while recovery is still possible:
      // record the deferred error in the set so an idle with no recovery
      // terminalizes the job as 'error' instead of a false completion.
      // When no chain exists, fallback is disabled, or the chain is
      // exhausted the error is final — record it now.
      if (
        !props?.error ||
        !isFailoverError(props.error) ||
        (isInlineFailoverError(props.error) &&
          !deps.options.willAttemptFallback?.(sessionId))
      ) {
        deps.deferredInlineErrors.delete(sessionId);
        deps.terminalJobsInjectedByParent.delete(sessionId);
        deps.pendingInjectedTerminalJobsByParent.delete(sessionId);
        // Record non-retryable errors on the job board so the
        // orchestrator sees the failure instead of a false completion.
        const job = observation?.job ?? deps.backgroundJobBoard.get(sessionId);
        if (job && job.state === 'running') {
          // BackgroundJobStore has no expected-generation/CAS form for
          // updateStatus. The check immediately above is the strongest
          // synchronous boundary available; a remote event cannot be made
          // atomic with a later relaunch through this API.
          if (
            observation &&
            !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
          ) {
            return;
          }
          const aborted = isAbortedSessionError(props?.error);
          // Armed BEFORE the write: `updateStatus` publishes the terminal to
          // the board's outcome listeners synchronously, and one of those is
          // this same tracker (`src/index.ts`). See `holdNotification`.
          if (aborted) {
            deps.revivedRunTracker?.holdNotification(
              sessionId,
              NOTIFICATION_CASCADE_DEFER_MS,
            );
          }
          const updated = deps.backgroundJobBoard.updateStatus({
            taskID: sessionId,
            state: 'error',
            expectedGeneration: observation?.generation,
            // The SDK error shape is `{ name, data: { message } }`, so a bare
            // `.message` read is undefined for every real session error and
            // every record ends up saying "Session error".
            resultSummary: sessionErrorMessage(props?.error, 'Session error'),
          });
          if (updated) {
            deps.revivedRunTracker?.onTerminal(
              updated,
              aborted ? { deferMs: NOTIFICATION_CASCADE_DEFER_MS } : undefined,
            );
          }
        }
      } else if (isInlineFailoverError(props.error)) {
        // Recovery possible: defer. The idle backstop terminalizes this
        // if the fallback fails silently; busy/deleted clears it.
        deps.deferredInlineErrors.add(sessionId);
      }
    } else if (sessionId) {
      // Child subagent sessions are not orchestrators, so the block
      // above never runs for them. Without this, a failed background
      // subagent leaves its job in `running` and the idle-reconciliation
      // path (which has no shouldManageSession guard) marks it
      // `completed` — a false success. A child with no fallback chain has
      // nothing to retry into, so surface the failure on the board.
      const props = input.event.properties as { error?: unknown } | undefined;
      if (deps.options.isFallbackInProgress?.(sessionId)) return;
      const job = observation?.job ?? deps.backgroundJobBoard.get(sessionId);
      if (job && job.state === 'running') {
        // This is a final synchronous generation check, not a claim that
        // updateStatus is a CAS operation; the store API cannot provide that.
        if (
          observation &&
          !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
        ) {
          return;
        }
        // A broken wire is not a failed task: the child's stream died and
        // the work it was doing has no known outcome. That distinction is
        // carried in the SUMMARY, not the state.
        //
        // The state stays `error` on purpose. `statusUncertain` was tried and
        // regressed recoverability: session.error ends the turn, so the child
        // goes idle, stop-confirmation overwrites the reason and confirms
        // `stopped` after its 5s grace — and a stopped record is not
        // revivable (`isReviveableRetainedJob` excludes it, and
        // `resolveRecoverable` requires `running`), so the transport cause was
        // lost along with the ability to resume the same session. An `error`
        // record IS revivable in place, which is exactly the affordance the
        // orchestrator needs here.
        const transport = isTransportError(props?.error);
        const childAborted = isAbortedSessionError(props?.error);
        // The cause of an abort is not knowable yet: the parent's own evidence
        // is ~100ms behind this event (probes B1/B3), and a user `stop` intent
        // is claimed two statements below. So a revived lane's parent
        // notification is held before the write — `updateStatus` publishes the
        // terminal to the board's outcome listeners synchronously, and one of
        // those listeners is this same tracker (`src/index.ts`), which would
        // otherwise put "failed" on the wire from inside this call.
        if (childAborted) {
          deps.revivedRunTracker?.holdNotification(
            sessionId,
            NOTIFICATION_CASCADE_DEFER_MS,
          );
        }
        const updated = deps.backgroundJobBoard.updateStatus({
          taskID: sessionId,
          state: 'error',
          expectedGeneration: observation?.generation,
          resultSummary: transport
            ? transportSessionErrorReason(props?.error)
            : sessionErrorMessage(props?.error, 'Session error'),
        });
        if (transport) {
          log('[task-session-manager] child transport error recorded', {
            sessionID: sessionId,
            alias: updated?.alias,
            resultSummary: updated?.resultSummary,
          });
        }
        // An abort is the only outcome a second terminal can cause, so this is
        // the one place a `omos lanes stop` can be attributed. The claim is
        // pull-based and consumes the line, so a later abort of the same lane
        // cannot inherit the label; the board itself refuses to overwrite an
        // orchestrator-owned cancellation.
        let terminal = updated;
        if (updated && childAborted) {
          const intent = deps.claimUserStopIntent?.(sessionId);
          if (intent) {
            terminal =
              deps.backgroundJobBoard.markCancelledByUser(
                sessionId,
                intent.reason,
              ) ?? updated;
            log('[task-session-manager] lane stopped by user (omos lanes)', {
              sessionID: sessionId,
              alias: terminal.alias,
              state: terminal.state,
              labelled: terminal.cancelledByUser !== undefined,
              reason: intent.reason,
            });
          } else {
            // Nobody asked for this one. It becomes a cascade CANDIDATE: an
            // orchestrator abort or idle within the window turns it into an
            // attributed cascade death, and anything else leaves it an
            // anonymous (but still revivable) error.
            deps.cascade?.noteChildAbort(sessionId, updated.parentSessionID);
          }
        }
        if (terminal) {
          deps.revivedRunTracker?.onTerminal(
            terminal,
            childAborted
              ? { deferMs: NOTIFICATION_CASCADE_DEFER_MS }
              : undefined,
          );
        }
      }
    }

    return;
  }

  if (input.event.type === 'session.status') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const statusType = (
      input.event.properties as { status?: { type?: string } } | undefined
    )?.status?.type;
    if (statusType !== 'busy') {
      if (sessionId) deps.idleSessionTokens.invalidate(sessionId);
      return;
    }
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          true,
        )
      : undefined;
    if (observation?.stale || observation?.activityFenceOnly) return;
    if (
      observation &&
      !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
    ) {
      return;
    }
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      // Feeds the cascade discriminator: a parent that was BUSY when its lane
      // died has an innocent reason to go idle right afterwards (probe B2), so
      // its idle needs two sibling deaths before it confirms anything.
      deps.cascade?.noteOrchestratorBusy(sessionId);
    }
    // A settled lane going busy is not something a lane does on its own. When
    // the user ran `omos lanes revive` from a second terminal, the intent line
    // it left behind is the only evidence — claimed here so the run can be
    // registered as a revived generation, exactly as `task_revive` would have,
    // and the parent still gets its synthesized terminal notification.
    if (sessionId && deps.claimUserReviveIntent && deps.adoptRevivedRun) {
      const settled =
        observation?.job ?? deps.backgroundJobBoard.get(sessionId);
      if (settled && isReviveableRetainedJob(settled)) {
        const intent = deps.claimUserReviveIntent(sessionId);
        if (intent) await deps.adoptRevivedRun(sessionId);
      }
    }
    // A busy EVENT (unlike a busy poll) is a transition the host only emits
    // when the session starts doing something, so it both seeds and refreshes
    // the activity clock.
    if (sessionId) {
      deps.backgroundJobBoard.recordActivity(sessionId, observedAt);
    }
    if (sessionId) deps.idleSessionTokens.invalidate(sessionId);
    // Live busy cancels a pending child idle-reconcile — the session
    // recovered (FG re-prompt or continued work).
    // Note: invalidate above already cleared the parent idle-reconcile
    // timer; clearIdleTimers handles the child timer.
    if (sessionId) {
      deps.idleReconciler.clearIdleTimers(sessionId);
      // Live busy after a deferred 401/410 means the fallback re-prompt
      // (or continued work) recovered the session — the error is not final.
      deps.deferredInlineErrors.delete(sessionId);
    }
    const before = sessionId
      ? (observation?.job ?? deps.backgroundJobBoard.get(sessionId))
      : undefined;
    const updated = sessionId
      ? deps.backgroundJobBoard.markRunningFromLiveSession(
          sessionId,
          observedAt,
          observation?.generation,
        )
      : undefined;
    if (before?.cancellationRequested) {
      log('[task-session-manager] busy observed after cancel request', {
        sessionID: sessionId,
        previousState: before.state,
        previousTerminalState: before.terminalState,
        terminalUnreconciled: before.terminalUnreconciled,
        resultSummary: before.resultSummary,
      });
    }
    log('[task-session-manager] busy/status busy observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      previousState: before?.state,
      previousTerminalState: before?.terminalState,
      previousCancellationRequested: before?.cancellationRequested ?? false,
      previousLastLiveBusyAt: before?.lastLiveBusyAt,
      updatedState: updated?.state,
      updatedCancellationRequested: updated?.cancellationRequested ?? false,
      updatedLastLiveBusyAt: updated?.lastLiveBusyAt,
    });
    return;
  }

  if (input.event.type !== 'session.deleted') return;
  const sessionId =
    input.event.properties?.info?.id || input.event.properties?.sessionID;
  if (!sessionId) return;

  const observedAt = eventActivityAt(input, deps.options.now?.() ?? Date.now());
  const observation = observeSessionEvent(
    deps.backgroundJobBoard,
    input,
    sessionId,
    observedAt,
    false,
  );
  const suppliedGeneration = eventGeneration(input);
  const hasCurrentGenerationProvenance =
    suppliedGeneration !== undefined &&
    observation.generation !== undefined &&
    suppliedGeneration === observation.generation;
  const ambiguousRelaunchDeletion =
    observation.job !== undefined &&
    observation.job.generation > 1 &&
    !hasCurrentGenerationProvenance;
  if (
    observation.stale ||
    observation.activityFenceOnly ||
    !isCurrentSessionObservation(deps.backgroundJobBoard, observation) ||
    ambiguousRelaunchDeletion
  ) {
    log(
      '[task-session-manager] ignored session.deleted without current-generation proof',
      {
        sessionID: sessionId,
        currentGeneration: observation.generation,
        eventGeneration: suppliedGeneration,
        observedAt,
        reason: ambiguousRelaunchDeletion
          ? 'OpenCode event has no generation/CAS provenance after relaunch'
          : 'generation or activity fence rejected deletion',
      },
    );
    return;
  }

  // Foreground-fallback teardown recreates the session; keep process-global
  // wait_for_user. Genuine deletion clears wait state for the session.
  if (deps.options.isFallbackInProgress?.(sessionId)) {
    deps.idleSessionTokens.invalidate(sessionId);
  } else {
    deps.idleSessionTokens.clearSession(sessionId);
  }
  deps.inputWaits.clearInputWaits(sessionId);
  deps.pendingCallTracker.clearSession(sessionId);
  deps.retainedBoardSnapshots.delete(sessionId);
  const fallbackInProgress =
    deps.options.isFallbackInProgress?.(sessionId) === true;
  const job = deps.backgroundJobBoard.get(sessionId);
  if (!fallbackInProgress || job?.deadlineExceededAt !== undefined) {
    deps.backgroundJobSupervisor?.onSessionDeleted(sessionId);
  }

  log('[task-session-manager] session.deleted observed', {
    sessionID: sessionId,
  });
  eventFenceMap(deps.backgroundJobBoard).delete(sessionId);
  injectedUserMessageMap(deps.backgroundJobBoard).delete(sessionId);
}
