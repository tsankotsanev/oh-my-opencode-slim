import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  ContextFile,
} from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import { sessionErrorMessage } from '../../utils/session-error';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from '../../utils/task';

const DEFAULT_NOTIFICATION_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TERMINAL_NOTIFICATION_TIMEOUT_MS = 10_000;
const DEFAULT_STABILIZATION_PROBES = 3;
const DEFAULT_STABILIZATION_DELAY_MS = 150;

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    error?: unknown;
    finish?: string;
    time?: { completed?: number };
  };
  parts?: Array<{
    type?: string;
    text?: string;
    state?: { status?: string };
  }>;
};

type RevivedRun = {
  taskID: string;
  generation: number;
  parentSessionID: string;
  baselineMessageID?: string;
  description: string;
  notification: {
    attempts: number;
    sent: boolean;
    pending: boolean;
    retryTimer?: ReturnType<typeof setTimeout>;
    /**
     * Earliest instant this run's parent notification may go on the wire.
     *
     * See {@link RevivedRunTracker.holdNotification} — an abort's CAUSE is not
     * knowable at the moment the abort lands, so the send waits for it.
     */
    holdUntil?: number;
    deferTimer?: ReturnType<typeof setTimeout>;
  };
  stabilizationProbes: number;
  stabilizationTimer?: ReturnType<typeof setTimeout>;
  terminalState?: 'completed' | 'error';
  probeInFlight?: Promise<boolean>;
};

export interface RevivedRunTracker {
  captureBaseline(taskID: string): Promise<string | undefined>;
  register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void;
  isTracked(taskID: string, generation: number): boolean;
  probe(taskID: string, generation: number): Promise<boolean>;
  onTerminal(record: BackgroundJobRecord, options?: { deferMs?: number }): void;
  /**
   * Hold this run's parent notification for `deferMs`, BEFORE the terminal
   * record exists.
   *
   * The reason this is a separate call and not just `onTerminal`'s option: the
   * board publishes every terminal transition to its own outcome listeners
   * (`src/index.ts` registers `onTerminal` as one), and that publication
   * happens SYNCHRONOUSLY inside `updateStatus`. By the time the event router
   * reaches its own `onTerminal(record, { deferMs })` call the prompt would
   * already be on the wire. So the router arms the hold first and the option
   * is only a second line of defence — relying on the two call paths landing
   * in a particular order is exactly the ordering bug this fixes.
   */
  holdNotification(taskID: string, deferMs: number): void;
  dispose(): void;
}

export function createRevivedRunTracker(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  maxNotificationRetries?: number;
  notificationRetryDelayMs?: number;
  maxStabilizationProbes?: number;
  stabilizationProbeDelayMs?: number;
  onRegister?: (taskID: string) => void;
  onSettled?: (taskID: string) => void;
  contextFilesForPrompt?: (taskID: string) => ContextFile[];
  pruneContext?: () => void;
  /** Test seams; default to the globals, so behaviour is unchanged. */
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): RevivedRunTracker {
  const runs = new Map<string, RevivedRun>();
  const now = options.now ?? (() => Date.now());
  const startTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  const maxNotificationRetries =
    options.maxNotificationRetries ?? DEFAULT_NOTIFICATION_RETRIES;
  const retryDelayMs =
    options.notificationRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxStabilizationProbes =
    options.maxStabilizationProbes ?? DEFAULT_STABILIZATION_PROBES;
  const stabilizationProbeDelayMs =
    options.stabilizationProbeDelayMs ?? DEFAULT_STABILIZATION_DELAY_MS;
  let disposed = false;

  const captureBaseline = async (
    taskID: string,
  ): Promise<string | undefined> => {
    const session = getClient(options.input).session;
    const messages =
      typeof session.messages === 'function'
        ? session.messages.bind(session)
        : undefined;
    if (typeof messages !== 'function') return undefined;
    const response = await messages({
      path: { id: taskID },
      query: { directory: options.input.directory },
    });
    const error = responseError(response);
    if (error !== undefined) throw new Error(errorText(error));
    const data = Array.isArray(response.data) ? response.data : [];
    const last = data.at(-1) as SessionMessage | undefined;
    return typeof last?.info?.id === 'string' ? last.info.id : undefined;
  };

  const isTracked = (taskID: string, generation: number): boolean => {
    const run = runs.get(taskID);
    return run?.generation === generation;
  };

  const probe = async (
    taskID: string,
    generation: number,
  ): Promise<boolean> => {
    const run = runs.get(taskID);
    if (!run || run.generation !== generation || disposed) return false;
    if (run.probeInFlight) return run.probeInFlight;

    run.probeInFlight = probeRun(run).finally(() => {
      run.probeInFlight = undefined;
    });
    return run.probeInFlight;
  };

  const onTerminal = (
    record: BackgroundJobRecord,
    options_?: { deferMs?: number },
  ): void => {
    const run = runs.get(record.taskID);
    if (!run || run.generation !== record.generation) return;
    if (options_?.deferMs !== undefined) {
      holdNotification(record.taskID, options_.deferMs);
    }
    if (record.state === 'cancelled') {
      settleRun(run, record);
      options.backgroundJobSupervisor?.onTerminal(record);
      discardRun(run);
      return;
    }
    if (record.state !== 'completed' && record.state !== 'error') {
      return;
    }
    finish(run, record);
  };

  const holdNotification = (taskID: string, deferMs: number): void => {
    const run = runs.get(taskID);
    if (!run || disposed || deferMs <= 0) return;
    // Never shortens an existing hold: two aborts landing on one lane must not
    // let the second one race the cause of the first onto the wire.
    const until = now() + deferMs;
    if (run.notification.holdUntil !== undefined) {
      if (until <= run.notification.holdUntil) return;
    }
    run.notification.holdUntil = until;
    // A send already scheduled under a shorter hold is re-armed, which is what
    // makes the router's `onTerminal(..., { deferMs })` still work when the
    // board's synchronous outcome listener got there first.
    if (run.notification.deferTimer) {
      clearTimeout(run.notification.deferTimer);
      run.notification.deferTimer = undefined;
      scheduleDeferredNotification(run);
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const run of runs.values()) {
      if (run.notification.retryTimer) {
        clearTimeout(run.notification.retryTimer);
      }
      if (run.notification.deferTimer) {
        clearTimeout(run.notification.deferTimer);
      }
      if (run.stabilizationTimer) {
        clearTimeout(run.stabilizationTimer);
      }
    }
    runs.clear();
  };

  async function probeRun(run: RevivedRun): Promise<boolean> {
    const session = getClient(options.input).session;
    const messages =
      typeof session.messages === 'function'
        ? session.messages.bind(session)
        : undefined;
    if (typeof messages !== 'function') return false;
    let response: unknown;
    try {
      response = await messages({
        path: { id: run.taskID },
        query: { directory: options.input.directory },
      });
    } catch {
      return false;
    }

    const data =
      isRecord(response) && Array.isArray(response.data)
        ? (response.data as SessionMessage[])
        : [];
    const baselineIndex = run.baselineMessageID
      ? data.findIndex((message) => message.info?.id === run.baselineMessageID)
      : -1;
    if (run.baselineMessageID && baselineIndex < 0) return false;

    const lastIndex = data.length - 1;
    const last = data[lastIndex];
    if (last?.info?.role !== 'assistant') return false;
    if (lastIndex <= baselineIndex) return false;
    if (typeof last.info.time?.completed !== 'number') return false;
    if (last.info.finish === 'tool-calls' || last.info.finish === 'unknown') {
      return false;
    }
    if (hasPendingToolCall(data, baselineIndex)) return false;
    if (last.info.error !== undefined) {
      // The SDK error shape is `{ name, data: { message } }`, so serializing it
      // whole put raw JSON in front of the orchestrator where a sentence
      // belongs (`Aborted`, `provider failed`).
      const result = sessionErrorMessage(
        last.info.error,
        'Revived child session failed.',
      );
      const updated = options.backgroundJobBoard.updateStatus({
        taskID: run.taskID,
        expectedGeneration: run.generation,
        state: 'error',
        resultSummary: result || 'Revived child session failed.',
      });
      return updated?.generation === run.generation && finish(run, updated);
    }
    const text = (last.parts ?? [])
      .filter(
        (part) =>
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.length > 0,
      )
      .map((part) => part.text as string)
      .join('\n\n')
      .trim();
    if (text.length > 0) {
      const updated = options.backgroundJobBoard.updateStatus({
        taskID: run.taskID,
        expectedGeneration: run.generation,
        state: 'completed',
        resultSummary: text,
      });
      return updated?.generation === run.generation && finish(run, updated);
    }

    if (run.stabilizationProbes >= maxStabilizationProbes) {
      const updated = options.backgroundJobBoard.updateStatus({
        taskID: run.taskID,
        expectedGeneration: run.generation,
        state: 'error',
        resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
        lastStatusError: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
      });
      return updated?.generation === run.generation && finish(run, updated);
    }

    run.stabilizationProbes += 1;
    scheduleStabilizationProbe(run);
    return false;
  }

  function finish(run: RevivedRun, record: BackgroundJobRecord): boolean {
    if (record.state !== 'completed' && record.state !== 'error') return false;
    if (run.stabilizationTimer) {
      clearTimer(run.stabilizationTimer);
      run.stabilizationTimer = undefined;
    }
    if (run.terminalState && run.terminalState !== record.state) return true;
    run.terminalState = record.state;
    // Everything except the notification settles NOW: the context files, the
    // supervisor and the board are all local, and only the parent prompt has
    // to wait for the cause of an abort to be established.
    settleRun(run, record);
    options.backgroundJobSupervisor?.onTerminal(record);
    if (run.notification.sent || run.notification.pending) return true;
    if (run.notification.deferTimer) return true;
    const delay = Math.max(0, (run.notification.holdUntil ?? 0) - now());
    if (delay > 0) {
      scheduleDeferredNotification(run);
      return true;
    }
    void notifyParent(run);
    return true;
  }

  /**
   * Wait out the hold, then decide from the record as it stands THEN.
   *
   * The delay is recomputed on every (re-)arm rather than captured, so a hold
   * extended after the timer was set lands at the later instant.
   */
  function scheduleDeferredNotification(run: RevivedRun): void {
    if (disposed || runs.get(run.taskID) !== run) return;
    if (run.notification.deferTimer) return;
    const delay = Math.max(0, (run.notification.holdUntil ?? 0) - now());
    run.notification.deferTimer = startTimer(() => {
      run.notification.deferTimer = undefined;
      void notifyParent(run);
    }, delay);
    run.notification.deferTimer?.unref?.();
  }

  function settleRun(run: RevivedRun, record: BackgroundJobRecord): void {
    options.backgroundJobBoard.addContext(
      record.taskID,
      options.contextFilesForPrompt?.(record.taskID) ?? [],
    );
    options.backgroundJobBoard.addContext(record.taskID, record.contextFiles);
    options.pruneContext?.();
    options.onSettled?.(run.taskID);
  }

  /**
   * Tell the parent how this run ended — reading the record as it stands NOW.
   *
   * Never from the record captured at `finish` time: on an abort that record
   * predates the evidence of what caused it by ~100ms (probes B1/B3), so a
   * captured render is guaranteed to say "failed" for every lane one ESC (or
   * one model failover) killed.
   */
  async function notifyParent(run: RevivedRun): Promise<void> {
    if (disposed || run.notification.sent || run.notification.pending) return;
    run.notification.pending = true;
    run.notification.attempts += 1;
    try {
      const session = getClient(options.input).session;
      const promptAsync =
        typeof session.promptAsync === 'function'
          ? session.promptAsync.bind(session)
          : undefined;
      if (typeof promptAsync !== 'function') {
        throw new Error('session.promptAsync unavailable');
      }
      const current = options.backgroundJobBoard.get(run.taskID);
      if (
        !current ||
        current.generation !== run.generation ||
        terminalOutcome(current) !== run.terminalState
      ) {
        discardRun(run);
        return;
      }
      // A cascade is ONE event with ONE recovery, and the board already
      // renders it that way: a per-lane Action plus a single group line, both
      // injected into a turn the orchestrator was going to take anyway. Waking
      // it N times to say "N of your lanes were interrupted, each intact" is
      // the cost this whole label exists to avoid — and under
      // `reviveOnCascade: 'auto'` it would announce a failure the plugin is
      // about to undo. A deliberate user stop still prompts: that one is a
      // decision the orchestrator must not sit on.
      if (current.killedByCascade && current.cancelledByUser === undefined) {
        log(
          '[revived-run-tracker] cascade lane: no parent prompt (the board carries it)',
          {
            taskID: run.taskID,
            alias: current.alias,
            cause: current.killedByCascade.cause,
            parentSessionID: run.parentSessionID,
          },
        );
        discardRun(run);
        return;
      }
      const lease = options.backgroundJobBoard.acquireTerminalNotificationLease(
        run.taskID,
        run.generation,
      );
      if (!lease) {
        scheduleNotificationRetry(run);
        return;
      }
      const state = run.terminalState === 'completed' ? 'completed' : 'error';
      const tag = state === 'completed' ? 'task_result' : 'task_error';
      const text = [
        `<task id="${run.taskID}" state="${state}">`,
        `<summary>${terminalSummary(run.description, current, state)}</summary>`,
        `<${tag}>`,
        ...terminalBody(current, state),
        `</${tag}>`,
        '</task>',
      ].join('\n');
      const response = await awaitNotificationTransport(
        options.backgroundJobBoard,
        lease,
        () =>
          promptAsync({
            path: { id: run.parentSessionID },
            query: { directory: options.input.directory },
            body: {
              agent: 'orchestrator',
              parts: [{ type: 'text', synthetic: true, text }],
            },
          }),
      );
      const error = responseError(response);
      if (error !== undefined) throw new Error(errorText(error));
      const latest = options.backgroundJobBoard.get(run.taskID);
      if (
        !latest ||
        latest.generation !== run.generation ||
        terminalOutcome(latest) !== run.terminalState
      ) {
        discardRun(run);
        return;
      }
      run.notification.sent = true;
    } catch {
      scheduleNotificationRetry(run);
    } finally {
      run.notification.pending = false;
    }
  }

  function scheduleNotificationRetry(run: RevivedRun): void {
    if (
      disposed ||
      runs.get(run.taskID) !== run ||
      run.notification.attempts >= maxNotificationRetries ||
      run.notification.retryTimer
    ) {
      return;
    }
    run.notification.retryTimer = startTimer(() => {
      run.notification.retryTimer = undefined;
      void notifyParent(run);
    }, retryDelayMs);
    run.notification.retryTimer?.unref?.();
  }

  function scheduleStabilizationProbe(run: RevivedRun): void {
    if (disposed || runs.get(run.taskID) !== run || run.stabilizationTimer) {
      return;
    }
    run.stabilizationTimer = startTimer(() => {
      run.stabilizationTimer = undefined;
      void probe(run.taskID, run.generation);
    }, stabilizationProbeDelayMs);
    run.stabilizationTimer?.unref?.();
  }

  function register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void {
    const old = runs.get(input.taskID);
    if (old?.notification.retryTimer) clearTimer(old.notification.retryTimer);
    if (old?.notification.deferTimer) clearTimer(old.notification.deferTimer);
    if (old?.stabilizationTimer) clearTimer(old.stabilizationTimer);
    runs.set(input.taskID, {
      ...input,
      notification: { attempts: 0, sent: false, pending: false },
      stabilizationProbes: 0,
    });
    options.onRegister?.(input.taskID);
  }

  function discardRun(run: RevivedRun): void {
    if (runs.get(run.taskID) !== run) return;
    if (run.notification.retryTimer) clearTimer(run.notification.retryTimer);
    if (run.notification.deferTimer) clearTimer(run.notification.deferTimer);
    if (run.stabilizationTimer) clearTimer(run.stabilizationTimer);
    runs.delete(run.taskID);
  }

  return {
    captureBaseline,
    register,
    isTracked,
    probe,
    onTerminal,
    holdNotification,
    dispose,
  };
}

async function awaitNotificationTransport<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  operation: () => Promise<T>,
): Promise<T> {
  let settled = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = Promise.resolve()
    .then(operation)
    .then(
      (value) => {
        settled = true;
        if (timedOut) backgroundJobBoard.releaseLease(lease);
        return value;
      },
      (error: unknown) => {
        settled = true;
        if (timedOut) backgroundJobBoard.releaseLease(lease);
        throw error;
      },
    );

  try {
    return await Promise.race([
      transport,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationTransportTimeoutError()),
          TERMINAL_NOTIFICATION_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof NotificationTransportTimeoutError) {
      timedOut = true;
      if (settled) backgroundJobBoard.releaseLease(lease);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) backgroundJobBoard.releaseLease(lease);
  }
}

class NotificationTransportTimeoutError extends Error {
  constructor() {
    super('Parent terminal notification transport timed out');
    this.name = 'NotificationTransportTimeoutError';
  }
}

/**
 * What the parent is told this run's outcome WAS.
 *
 * Upstream's two shapes (`completed` / `failed`) are right for a run that ran
 * and ended. They are actively wrong for the two ways a lane dies without
 * failing at anything, and both are reachable on a revived run:
 *
 *   - the user stopped it from a second terminal (`omos lanes stop`), which
 *     lands as an aborted `error` record. "Background task failed: Session
 *     error" invites the orchestrator to diagnose and retry a task the human
 *     deliberately ended;
 *   - an abort of the orchestrator, which cascades to every lane — ESC, or the
 *     plugin's own model failover.
 *
 * The second one is not handled here: `notifyParent` sends no prompt at all
 * for a cascade lane, because one abort produces N of them and the board
 * already renders the group in a turn the orchestrator was taking anyway. So
 * the only label this pair has to render is the user's own stop, which is a
 * DECISION the orchestrator must not sit on until its next turn.
 *
 * `cancelledByUser` is a LABEL on the record: the state stays whatever the
 * lifecycle recorded, so this only changes what the parent reads, never what
 * the board considers finished.
 */
function terminalSummary(
  description: string,
  record: BackgroundJobRecord,
  state: 'completed' | 'error',
): string {
  if (state === 'completed') return `Background task completed: ${description}`;
  const stop = record.cancelledByUser;
  if (stop) {
    const reason = stop.reason ? ` (${stop.reason})` : '';
    return `Background task stopped by the user (omos lanes stop): ${description}${reason}`;
  }
  return `Background task failed: ${description}`;
}

/** Body of the notification: the cause first, then whatever was recorded. */
function terminalBody(
  record: BackgroundJobRecord,
  state: 'completed' | 'error',
): string[] {
  const recorded =
    record.resultSummary ?? (state === 'completed' ? 'Completed.' : 'Failed.');
  if (state === 'completed') return [recorded];

  const stop = record.cancelledByUser;
  if (stop) {
    return [
      `The user stopped this lane from a second terminal${
        stop.reason ? `: ${stop.reason}` : ''
      }. Treat it as a cancellation - do not relaunch it unasked; its session is intact, so task_revive(task_id) resumes it if the user asks.`,
      recorded,
    ];
  }
  return [recorded];
}

function terminalOutcome(
  record: BackgroundJobRecord,
): 'completed' | 'error' | undefined {
  if (record.state === 'reconciled') {
    return record.terminalState === 'completed' ||
      record.terminalState === 'error'
      ? record.terminalState
      : undefined;
  }
  return record.state === 'completed' || record.state === 'error'
    ? record.state
    : undefined;
}

function hasPendingToolCall(
  messages: SessionMessage[],
  baselineIndex: number,
): boolean {
  return messages.slice(baselineIndex + 1).some((message) =>
    (message.parts ?? []).some((part) => {
      if (part.type !== 'tool') return false;
      const status = part.state?.status;
      return status !== 'completed' && status !== 'error';
    }),
  );
}

function responseError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  return response.error === undefined || response.error === null
    ? undefined
    : response.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
