/**
 * Silence detection: makes a frozen lane visible without inventing a state.
 *
 * A hung provider stream (wifi drop, dead socket) leaves a child session
 * nominally BUSY while producing nothing, forever. Upstream's liveness
 * reconciliation treats `busy` as proof of life, so such a lane stays
 * `running` and the orchestrator waits indefinitely. Per the opencode 1.18.26
 * probes (`docs/agents/subagent-probe-results.md`), busy+silent is the ONLY
 * signature of that fault: the message log looks identical to a healthy lane,
 * and `info.time.completed` / tool `state.status` are traps that read
 * "finished" on interrupted messages.
 *
 * So the detector is a clock, not a new poller and not a new board state. It
 * runs inside the existing 5s reconciliation cycle, reuses that cycle's single
 * `GET /session/status` map, and reports its verdict as upstream's
 * `statusUncertain` plus a frozen reason.
 *
 * Exemptions, all of them lanes that are silent BY DESIGN:
 *
 * | condition                    | why it is not a freeze                  |
 * |------------------------------|-----------------------------------------|
 * | any unfinished tool part     | tool execution emits nothing at all     |
 * | live status is `retry`       | provider retry is healthy, self-healing |
 * | awaiting permission / HITL   | blocked on a human, not hung            |
 *
 * Recovery is never inferred from a `busy` poll: for a silent lane that poll
 * IS the freeze signature. Only real output (`recordActivity`, driven by
 * message/part events in the event router) clears the flag.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  LaneProgress,
} from '../../utils';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';

/** Default silence budget before a busy lane is flagged. */
export const DEFAULT_STALE_AFTER_MS = 300_000;

/** Floor for the configurable budget; below this, normal pauses false-alarm. */
export const MIN_STALE_AFTER_MS = 10_000;

/** One bounded probe per flagged lane; never allowed to stall the cycle. */
export const SILENCE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Upper bound on a lane parked in a single tool call.
 *
 * A lane awaiting a tool result emits nothing, so it cannot be judged by
 * silence — but a tool that has not returned in half an hour is itself a fault
 * worth surfacing. Internal on purpose: this is a backstop, not a knob.
 */
export const DEFAULT_TOOL_STALE_AFTER_MS = 30 * 60_000;

/** Max length of the partial-progress excerpt stored on the board. */
const PROGRESS_TEXT_MAX_CHARS = 300;

/** Tool-part statuses that mean "still executing, no events expected". */
const UNFINISHED_TOOL_STATUSES = new Set(['running', 'pending']);

type AssistantEntry = { info: { role: 'assistant' }; parts: unknown[] };

function isAssistantEntry(value: unknown): value is AssistantEntry {
  if (!isRecord(value)) return false;
  const info = value.info;
  // OpenCode can emit partial/streaming entries whose `info` is missing even
  // though its own types declare it required, so guard instead of asserting.
  return isRecord(info) && info.role === 'assistant';
}

function entryParts(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value.parts) ? value.parts : [];
}

function textOf(entry: unknown): string {
  return entryParts(entry)
    .flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An unfinished tool call in the LAST assistant message.
 *
 * Only the last message counts: opencode starts a new assistant message after
 * tool execution, so an earlier one cannot be mid-tool. Within it, ANY tool
 * part still `running`/`pending` means the lane is executing — with parallel
 * tool calls the last-created part can finish first while an earlier one (a
 * long `bun test`, say) is still going, so checking only the tail part would
 * falsely flag a healthy lane. The first unfinished call is reported.
 */
export function pendingToolCall(
  messages: unknown[],
): { name: string; status: string } | undefined {
  const last = messages.at(-1);
  if (!isAssistantEntry(last)) return undefined;
  for (const part of entryParts(last)) {
    if (!isRecord(part) || part.type !== 'tool') continue;
    if (typeof part.tool !== 'string') continue;
    const state = isRecord(part.state) ? part.state : undefined;
    const status = typeof state?.status === 'string' ? state.status : 'unknown';
    if (UNFINISHED_TOOL_STATUSES.has(status)) {
      return { name: part.tool, status };
    }
  }
  return undefined;
}

/**
 * Extract whatever partial work the log shows, so a frozen lane can report
 * what it was doing instead of leaving the orchestrator to guess.
 *
 * Derived from the SAME `session.messages` response as the tool check, so it
 * costs no extra round-trip.
 */
export function captureLaneProgress(
  messages: unknown[],
  now: number,
): LaneProgress {
  if (messages.length === 0) return { messageCount: 0, capturedAt: now };

  let text: string | undefined;
  let lastTool: { name: string; status: string } | undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!isAssistantEntry(entry)) continue;
    if (text === undefined) {
      const entryText = textOf(entry);
      if (entryText) text = entryText.slice(0, PROGRESS_TEXT_MAX_CHARS);
    }
    if (lastTool === undefined) {
      const parts = entryParts(entry);
      for (let p = parts.length - 1; p >= 0; p -= 1) {
        const part = parts[p];
        if (!isRecord(part) || part.type !== 'tool') continue;
        if (typeof part.tool !== 'string') continue;
        const state = isRecord(part.state) ? part.state : undefined;
        lastTool = {
          name: part.tool,
          status: typeof state?.status === 'string' ? state.status : 'unknown',
        };
        break;
      }
    }
    if (text !== undefined && lastTool !== undefined) break;
  }

  return { text, lastTool, messageCount: messages.length, capturedAt: now };
}

/** Reason text for a busy-but-silent lane. Frozen by the board on first use. */
export function silenceReasonText(
  silentMs: number,
  awaitingTool?: { name: string },
): string {
  const seconds = Math.round(silentMs / 1000);
  return awaitingTool
    ? `no activity for ${seconds}s while awaiting tool ${awaitingTool.name}`
    : `no activity for ${seconds}s while busy`;
}

export type LaneMessagesProbe =
  | { messages: unknown[] }
  | { messages?: undefined; error: string };

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Lane message probe timed out'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One bounded `session.messages` read for a single lane. */
export async function probeLaneMessages(
  input: PluginInput,
  sessionID: string,
  timeoutMs: number = SILENCE_PROBE_TIMEOUT_MS,
): Promise<LaneMessagesProbe> {
  try {
    const client =
      typeof input.client?.session?.messages === 'function'
        ? input.client
        : getClient(input);
    const response = await withTimeout(
      client.session.messages({
        path: { id: sessionID },
        ...(input.directory ? { query: { directory: input.directory } } : {}),
      }),
      timeoutMs,
    );
    const data = (response as { data?: unknown }).data;
    return { messages: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface SilenceMonitorOptions {
  backgroundJobBoard: BackgroundJobStore;
  input: PluginInput;
  enabled?: boolean;
  staleAfterMs?: number;
  toolStaleAfterMs?: number;
  probeTimeoutMs?: number;
  /**
   * Permission/HITL seam. A lane blocked on a human answering a prompt is not
   * frozen and must never be flagged.
   */
  hasInputWait?: (sessionID: string) => boolean;
  /** Test seams. */
  now?: () => number;
  probe?: (sessionID: string) => Promise<LaneMessagesProbe>;
}

export interface SilenceMonitor {
  /**
   * Judge one running lane the live status map reports as busy or retrying.
   * Called from inside the reconciliation cycle, once per lane per pass.
   *
   * Takes no timestamp on purpose: the silence clock is this monitor's own,
   * shared with the heartbeat written by the event router, and must not be
   * confused with the reconciler's request/observation ordering stamps.
   */
  observe(job: BackgroundJobRecord, status: 'busy' | 'retry'): Promise<void>;
  /** Forget bookkeeping for lanes that are no longer running. */
  prune(runningTaskIDs: Set<string>): void;
  readonly enabled: boolean;
}

interface LaneTracking {
  generation: number;
  /**
   * First busy sighting of this generation.
   *
   * Needed as a silence baseline floor because a lane rehydrated from
   * transcript history carries `runStartedAt: 0` (historical parts have no
   * trustworthy launch timestamp), which would otherwise read as "silent
   * since the epoch" on the very first pass.
   */
  firstBusyAt: number;
  /** Rate-limits our own probing; never counts as lane activity. */
  lastProbeAt?: number;
}

export function createSilenceMonitor(
  options: SilenceMonitorOptions,
): SilenceMonitor {
  const enabled = options.enabled ?? true;
  const now = options.now ?? (() => Date.now());
  const staleAfterMs = Math.max(
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    MIN_STALE_AFTER_MS,
  );
  const toolStaleAfterMs =
    options.toolStaleAfterMs ?? DEFAULT_TOOL_STALE_AFTER_MS;
  const probe =
    options.probe ??
    ((sessionID: string) =>
      probeLaneMessages(
        options.input,
        sessionID,
        options.probeTimeoutMs ?? SILENCE_PROBE_TIMEOUT_MS,
      ));

  const tracking = new Map<string, LaneTracking>();

  function trackingFor(
    job: BackgroundJobRecord,
    observedAt: number,
  ): LaneTracking {
    const existing = tracking.get(job.taskID);
    if (existing && existing.generation === job.generation) return existing;
    const fresh: LaneTracking = {
      generation: job.generation,
      firstBusyAt: observedAt,
    };
    tracking.set(job.taskID, fresh);
    return fresh;
  }

  /**
   * Newest evidence that this lane was moving.
   *
   * `lastLiveBusyAt` is deliberately EXCLUDED: upstream's poller refreshes it
   * every 5s from the same busy reading we are trying to distrust, so
   * including it would make the silence window never close.
   */
  function silenceBaseline(
    job: BackgroundJobRecord,
    track: LaneTracking,
  ): number {
    return Math.max(
      job.lastActivityAt ?? 0,
      job.runStartedAt,
      track.firstBusyAt,
    );
  }

  async function observe(
    job: BackgroundJobRecord,
    status: 'busy' | 'retry',
  ): Promise<void> {
    if (!enabled) return;
    const observedAt = now();
    const track = trackingFor(job, observedAt);

    // A provider retry is a healthy, self-resolving state: the lane genuinely
    // has nothing to emit until the retry lands. It still refreshes the
    // baseline so the silence clock restarts once the retry ends.
    if (status === 'retry') {
      track.firstBusyAt = observedAt;
      return;
    }

    const silentMs = observedAt - silenceBaseline(job, track);
    if (silentMs <= staleAfterMs) return;

    // At most one probe per lane per silence budget, whether or not the lane
    // is already flagged.
    if (
      track.lastProbeAt !== undefined &&
      observedAt - track.lastProbeAt < staleAfterMs
    ) {
      return;
    }

    if (options.hasInputWait?.(job.taskID)) {
      log('[task-session-manager] silence: awaiting user input', {
        taskID: job.taskID,
        alias: job.alias,
        silentMs,
      });
      return;
    }

    track.lastProbeAt = observedAt;
    const result = await probe(job.taskID);
    if (result.messages === undefined) {
      // A failed probe proves nothing about the lane. Upstream already owns
      // "the runtime lookup failed" uncertainty; do not invent a second,
      // weaker claim from it.
      log('[task-session-manager] silence: lane probe failed', {
        taskID: job.taskID,
        alias: job.alias,
        error: result.error,
      });
      return;
    }

    // Re-verify after the await: a busy event, a cancel, a terminal result or
    // a relaunch may have landed while the probe was in flight.
    const after = options.backgroundJobBoard.get(job.taskID);
    if (after?.state !== 'running' || after.generation !== job.generation) {
      return;
    }
    if (options.hasInputWait?.(job.taskID)) return;

    const at = now();
    const progress = captureLaneProgress(result.messages, at);
    const stillSilentMs = at - silenceBaseline(after, track);
    const awaitingTool = pendingToolCall(result.messages);

    // Real output arrived during the probe: the lane is alive and its own
    // lifecycle owns it from here.
    if (stillSilentMs <= staleAfterMs) return;

    // A lane parked in an unfinished tool call is silent by design — nothing
    // is emitted between a tool part's running and completed updates. Only the
    // tool-specific backstop applies.
    if (awaitingTool && stillSilentMs <= toolStaleAfterMs) {
      options.backgroundJobBoard.recordProgress(
        job.taskID,
        progress,
        job.generation,
      );
      log('[task-session-manager] silence: awaiting tool result', {
        taskID: job.taskID,
        alias: after.alias,
        tool: awaitingTool.name,
        toolStatus: awaitingTool.status,
        silentMs: stillSilentMs,
      });
      return;
    }

    // Already flagged: refresh the progress excerpt only. The reason keeps its
    // original seconds count (the board enforces this) so an unchanged lane
    // renders byte-identically on every injection.
    if (after.silenceDetectedAt !== undefined) {
      options.backgroundJobBoard.recordProgress(
        job.taskID,
        progress,
        job.generation,
      );
      log('[task-session-manager] silence: still silent, progress refreshed', {
        taskID: job.taskID,
        alias: after.alias,
        silentMs: stillSilentMs,
      });
      return;
    }

    log('[task-session-manager] silence: busy but silent', {
      taskID: job.taskID,
      alias: after.alias,
      silentMs: stillSilentMs,
      awaitingTool: awaitingTool?.name,
      messageCount: progress.messageCount,
    });
    options.backgroundJobBoard.markSilenceDetected(
      job.taskID,
      silenceReasonText(stillSilentMs, awaitingTool),
      { progress, now: at, expectedGeneration: job.generation },
    );
  }

  return {
    observe,
    prune(runningTaskIDs: Set<string>): void {
      for (const taskID of [...tracking.keys()]) {
        if (!runningTaskIDs.has(taskID)) tracking.delete(taskID);
      }
    },
    enabled,
  };
}
