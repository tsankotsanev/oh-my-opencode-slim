/**
 * The one way a retained session is put back to work.
 *
 * Three callers need the same sequence and must not each invent it:
 *
 *   - `task_revive` — the orchestrator's own tool (unchanged behaviour; it
 *     supplies its own prompt body and error wording);
 *   - cascade auto-revive (`backgroundJobs.reviveOnCascade: 'auto'`), which
 *     sends {@link RESUME_PROMPT_TEXT} itself;
 *   - adoption of a run `omos lanes revive` already prompted from another
 *     process, where the prompt has happened and only the bookkeeping is left.
 *
 * The sequence is upstream's, and every step of it earns its place:
 *
 *   1. **relaunch lease** — proves nothing else (a cancel, a second revive) is
 *      mid-operation on this session, and authorizes the same-ID relaunch;
 *   2. **baseline message id** — the fence the revived-run tracker uses to tell
 *      the NEW run's output from the old transcript. Without it the tracker
 *      would read the previous run's last assistant message — which on an
 *      aborted lane carries `time.completed` AND an error (probe D) — and
 *      publish an immediate false terminal;
 *   3. **`registerLaunch`** — a new generation, which is what makes every stale
 *      event and probe for the previous run fall on the floor;
 *   4. **`revivedRunTracker.register`** — a revived run produces no native
 *      `task` tool call, so nothing else would ever synthesize the `<task>`
 *      notification the parent is waiting for (probe B2: the parent is never
 *      told). This is the whole reason the tracker exists, and the reason this
 *      module wraps it instead of growing a second one;
 *   5. **supervisor + immediate probe** — wall-clock supervision follows the
 *      new generation, and a lane that finishes before the first event arrives
 *      is still reported.
 *
 * On failure the record is marked `statusUncertain` rather than left claiming
 * to run: a relaunch whose outcome we do not know is exactly that.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundJobRecord } from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../../utils/continuation-model-selection';
import { isRecord } from '../../utils/guards';
import { RESUME_PROMPT_TEXT } from '../../utils/lane-control';
import { isReviveableRetainedJob } from '../../utils/lane-state';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import { withAgent } from '../../utils/prompt-agent';
import type { RevivedRunTracker } from './revived-run-tracker';

/**
 * Something else is mid-operation on this session, so the relaunch was not
 * even attempted.
 *
 * A type rather than a message, because callers have to distinguish it: it is
 * the one relaunch failure that is purely transient (a cancel or a second
 * revive holding the lease) and therefore worth retrying, and `task_revive`
 * renders it differently. Matching on the string was one rename away from
 * silently reclassifying it as a hard failure.
 */
export class RelaunchLeaseUnavailableError extends Error {
  constructor() {
    super('relaunch lease unavailable');
    this.name = 'RelaunchLeaseUnavailableError';
  }
}

export interface RetainedRunDeps {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
}

export interface RetainedRunLaunchRequest {
  /** The record the caller has already verified; its generation fences the lease. */
  record: BackgroundJobRecord;
  /**
   * Send the prompt that starts the new run.
   *
   * Omitted for adoption: `omos lanes revive` already prompted the session
   * from another process, and this call only registers the run it started.
   */
  sendPrompt?: () => Promise<void>;
  /**
   * Baseline fence for the tracker.
   *
   * `undefined` means "capture it now" (correct when the prompt has not been
   * sent yet). Adoption passes its own, computed after the fact.
   */
  baselineMessageID?: string;
  /** Names the caller in the `statusUncertain` text left behind on failure. */
  label: string;
}

/**
 * Relaunch a retained session's run and hand it to the revived-run tracker.
 *
 * Throws on every failure path, having already released the lease. The caller
 * owns the user-facing wording.
 */
export async function launchRetainedRun(
  deps: RetainedRunDeps,
  request: RetainedRunLaunchRequest,
): Promise<BackgroundJobRecord> {
  const { record, label } = request;
  const board = deps.backgroundJobBoard;
  const relaunchLease = board.acquireRelaunchLease(
    record.taskID,
    record.generation,
  );
  if (!relaunchLease) {
    throw new RelaunchLeaseUnavailableError();
  }

  let launched: BackgroundJobRecord | undefined;
  try {
    const baselineMessageID =
      request.baselineMessageID ??
      (await deps.revivedRunTracker.captureBaseline(record.taskID));

    await request.sendPrompt?.();

    launched = board.registerLaunch({
      taskID: record.taskID,
      parentSessionID: record.parentSessionID,
      agent: record.agent,
      description: record.description,
      objective: record.objective,
      background: true,
      relaunchLease,
    });
    if (launched.generation <= record.generation) {
      throw new Error('did not receive a new generation');
    }
    deps.revivedRunTracker.register({
      taskID: launched.taskID,
      generation: launched.generation,
      parentSessionID: launched.parentSessionID,
      baselineMessageID,
      description: launched.description,
    });
    deps.backgroundJobSupervisor?.onLaunch(launched);
    await deps.revivedRunTracker.probe(launched.taskID, launched.generation);
    return launched;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (launched) {
      board.markStatusUncertain(
        record.taskID,
        `${label} failed: ${message}`,
        launched.generation,
      );
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    board.releaseLease(relaunchLease);
  }
}

/**
 * Resume a settled lane in place, from inside the plugin.
 *
 * Both identities are pinned, and both for measured reasons:
 *   - `agent`, or the server silently rewrites the session to `build` on
 *     accept (probe A2);
 *   - `model`, because core resolves `input.model ?? agent.model ??
 *     currentModel(session)`, so an agent-only body re-pins a lane that
 *     foreground fallback had moved off its primary straight back onto the
 *     model that was failing it.
 *
 * A lane whose model cannot be established is therefore refused rather than
 * prompted unpinned — the same rule `task_message` and `omos lanes say` apply.
 */
export async function resumeRetainedLane(
  deps: RetainedRunDeps,
  record: BackgroundJobRecord,
  options: { prompt?: string; label?: string } = {},
): Promise<BackgroundJobRecord> {
  const agent = record.agent?.trim();
  if (!agent) {
    throw new Error(
      'no recorded agent; prompting without it would rewrite the session to "build"',
    );
  }
  const pinned = await resolveLaneModelPin(deps.input, record.taskID);
  if (!pinned) {
    throw new Error(
      'current model could not be established; refusing to prompt unpinned',
    );
  }

  const session = getClient(deps.input).session;
  if (typeof session.promptAsync !== 'function') {
    throw new Error('the host session does not support promptAsync');
  }

  return launchRetainedRun(deps, {
    record,
    label: options.label ?? 'auto-revive',
    sendPrompt: async () => {
      const response = await session.promptAsync({
        path: { id: record.taskID },
        query: { directory: deps.input.directory },
        body: withAgent(
          {
            model: pinned.model,
            ...(pinned.variant ? { variant: pinned.variant } : {}),
            parts: [
              {
                type: 'text' as const,
                text: options.prompt ?? RESUME_PROMPT_TEXT,
              },
            ],
          },
          agent,
        ),
      });
      const error = responseError(response);
      if (error !== undefined) throw new Error(errorText(error));
    },
  });
}

/**
 * Adopt a run `omos lanes revive` started from another process.
 *
 * The CLI cannot register a generation or a tracker entry — it is a different
 * process, and the board lives in the server. What it CAN do is leave a
 * `revive` intent on disk before prompting; the event router claims that line
 * when the resulting busy signal arrives and calls this, so a CLI revive ends
 * up in exactly the same state a `task_revive` would have produced, including
 * the synthesized parent notification.
 *
 * Returns `undefined` when the record is no longer in a shape worth adopting
 * (already relaunched by something else, or no longer retained).
 */
export async function adoptRevivedRun(
  deps: RetainedRunDeps,
  taskID: string,
): Promise<BackgroundJobRecord | undefined> {
  const record = deps.backgroundJobBoard.get(taskID);
  if (!record || !isReviveableRetainedJob(record)) return undefined;

  const baselineMessageID = await captureAdoptionBaseline(deps.input, taskID);
  const launched = await launchRetainedRun(deps, {
    record,
    baselineMessageID,
    label: 'omos lanes revive',
  });
  return deps.backgroundJobBoard.markRevivedByUser(launched.taskID) ?? launched;
}

/**
 * Baseline for a run whose prompt has ALREADY been sent.
 *
 * The tracker's own `captureBaseline` takes the last message, which is right
 * only before prompting. Here the injected user message — and possibly the new
 * assistant message the server has just opened — already exist, and picking
 * that in-flight assistant as the fence would mean the tracker never sees a
 * message "after" the baseline and never publishes anything.
 *
 * So: walk back over trailing assistant messages that have not completed. What
 * is left is the last settled message, which is the correct fence in every
 * ordering (user message present or not).
 */
async function captureAdoptionBaseline(
  input: PluginInput,
  taskID: string,
): Promise<string | undefined> {
  const session = getClient(input).session;
  if (typeof session.messages !== 'function') return undefined;
  let response: unknown;
  try {
    response = await session.messages({
      path: { id: taskID },
      query: { directory: input.directory },
    });
  } catch {
    return undefined;
  }
  const data =
    isRecord(response) && Array.isArray(response.data) ? response.data : [];

  for (let index = data.length - 1; index >= 0; index -= 1) {
    const entry = data[index];
    const info =
      isRecord(entry) && isRecord(entry.info) ? entry.info : undefined;
    if (!info) continue;
    const completed = isRecord(info.time) ? info.time.completed : undefined;
    if (info.role === 'assistant' && typeof completed !== 'number') continue;
    return typeof info.id === 'string' ? info.id : undefined;
  }
  return undefined;
}

/**
 * The lane's live model, most authoritative source first.
 *
 * Mirrors the CLI's `resolveLaneModel` (and `task_message`): the session
 * record's own model is whatever foreground fallback last moved it to; the
 * newest user message is the fallback for hosts that omit it.
 */
export async function resolveLaneModelPin(
  input: PluginInput,
  sessionID: string,
): Promise<ContinuationModelSelection | undefined> {
  const session = getClient(input).session;
  if (typeof session.get === 'function') {
    try {
      const response = await session.get({
        path: { id: sessionID },
        query: { directory: input.directory },
      });
      const data: unknown = response?.data;
      if (!responseError(response) && isRecord(data)) {
        const selection = parseContinuationModelSelection(
          data.model,
          data.variant,
        );
        if (selection) return selection;
      }
    } catch {
      // Fall through: the prompt call reports an unreachable host, not this.
    }
  }

  if (typeof session.messages !== 'function') return undefined;
  try {
    const response = await session.messages({
      path: { id: sessionID },
      query: { directory: input.directory },
    });
    const data: unknown = response?.data;
    if (responseError(response) || !Array.isArray(data)) return undefined;
    for (let index = data.length - 1; index >= 0; index -= 1) {
      const entry: unknown = data[index];
      if (!isRecord(entry) || !isRecord(entry.info)) continue;
      if (entry.info.role !== 'user') continue;
      return parseContinuationModelSelection(
        entry.info.model,
        entry.info.variant,
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Log helper shared by the two plugin-side revive callers. */
export function logReviveFailure(
  context: Record<string, unknown>,
  error: unknown,
): void {
  log('[task-session-manager] revive failed', {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
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
