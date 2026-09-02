/**
 * Session-id resolution for OpenCode lifecycle events.
 *
 * This file used to also own `TaskActivityTracker`, a second in-memory
 * activity clock feeding `task_status`'s `possibly_stuck`. It was deleted: the
 * board record is now the single activity clock (`lastActivityAt`, written by
 * the task-session-manager event router, plus the `silenceDetectedAt` verdict
 * from silence detection). Two clocks with different event sets, thresholds
 * and exemptions gave the orchestrator contradictory answers — a lane
 * streaming a long reply read as stuck here while the job board reported it
 * running, and a lane legitimately parked in a long tool call read as stuck
 * even though silence detection exempts it.
 *
 * What remains is the event→session-id mapping, which is still needed by the
 * tool-loop guard and companion wiring in `src/index.ts`.
 */

/**
 * Activity event shapes the resolver consumes. `info.id` is the session id
 * for session-scoped events (session.*) but the message/step id for
 * message-scoped events (message.updated, step-finish); the session id for
 * those lives in `info.sessionID`.
 */
export interface ActivityEvent {
  type: string;
  properties?: {
    info?: { id?: string; sessionID?: string };
    sessionID?: string;
    status?: { type?: string };
  };
}

/**
 * Resolves the session id from an event, keying message/step-scoped events
 * by `info.sessionID` (never the message id) and session-scoped events by
 * `info.id`. Returns undefined when no session id is present.
 */
export function resolveEventSessionID(
  event: ActivityEvent,
): string | undefined {
  const info = event.properties?.info;
  if (event.type === 'message.updated' || event.type === 'step-finish') {
    return info?.sessionID ?? event.properties?.sessionID;
  }
  return info?.id ?? event.properties?.sessionID;
}
