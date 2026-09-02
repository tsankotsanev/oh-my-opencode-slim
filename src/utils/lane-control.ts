/**
 * Out-of-band control channel between a running OpenCode server and the
 * `omos lanes` CLI in a second terminal.
 *
 * The problem it solves: the user runs ONE long-lived orchestrator session,
 * and every question about its background lanes ("what is running?", "stop
 * that one", "tell it to also check X") otherwise costs a model turn, because
 * the only way to reach a lane is to ask the orchestrator. This module gives
 * the CLI what it needs to talk to the server directly, at zero tokens.
 *
 * Two artefacts, next to the lane mirror (`src/utils/lane-mirror.ts`, which
 * documents the full file table and the one-writer-per-file rule):
 *
 *   - `<key>.server.json` — plugin → CLI: where this directory's server lives.
 *   - `<key>.intents.jsonl` — CLI → plugin: why a lane was just aborted, or
 *     that the busy signal about to arrive is a resume the user asked for.
 *
 * Nothing here may throw into a hook path: the sidecar runs inside plugin
 * startup and the intent lookup runs inside the event pipeline, so every entry
 * point swallows I/O and parse failures and degrades to "no information".
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalDirectory, laneStateDir, laneStateKey } from './lane-mirror';
import { log } from './logger';

/** Sidecar refresh cadence: proves the record is still live, cheaply. */
export const SIDECAR_REFRESH_MS = 120_000;

/**
 * A sidecar that has missed three consecutive heartbeats is stale.
 *
 * Strictly better than the pid probe (which a recycled pid passes) and than
 * the directory check (which a stale record for the RIGHT directory also
 * passes), so a cold heartbeat is treated as stale rather than warned about.
 */
export const SIDECAR_STALE_AFTER_MS = 3 * SIDECAR_REFRESH_MS;

/**
 * Floor between sidecar writes. `refresh()` is also called from the mirror
 * flush path, which can fire once a second during a busy turn; the only field
 * that changes is `updatedAt`, so coalescing costs the reader nothing.
 */
const DEFAULT_SIDECAR_MIN_WRITE_INTERVAL_MS = 30_000;

/** A `stop` intent only explains an abort that follows it almost immediately. */
export const STOP_INTENT_WINDOW_MS = 60_000;

/**
 * A `revive` intent only explains the busy signal that follows it.
 *
 * Same order of magnitude as the stop window and for the same reason: the CLI
 * writes the line, then prompts, and the server emits `session.status{busy}`
 * within milliseconds. A minute is generous slack for a loaded host.
 *
 * Beyond that the line expires unread, and the consequence is worth being
 * precise about: the SESSION still resumes (the prompt was already accepted
 * and the lane does the work), but nothing registers a new generation for it,
 * so the board keeps the terminal record it already had — a live busy signal
 * on a canonical terminal record only refreshes `lastLiveBusyAt`. The lane
 * therefore still reads as interrupted, and no `<task>` notification is
 * synthesized when it finishes.
 */
export const REVIVE_INTENT_WINDOW_MS = 60_000;

/** Intent lines older than this are ignored and pruned on the next read. */
export const INTENT_RETENTION_MS = 600_000;

/** Hard cap on how much of an intents file we are willing to parse. */
const MAX_INTENTS_BYTES = 256 * 1024;

/**
 * Where the server that owns `directory` can be reached.
 *
 * `pid` and `startedAt` exist so a reader can tell a live server from a stale
 * file left by a crashed one; `updatedAt` is refreshed periodically so
 * staleness is observable even when the pid was recycled.
 */
export interface ServerInfo {
  url: string;
  directory: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
}

/**
 * The one resume prompt, shared by `omos lanes revive` and the plugin's
 * cascade auto-revive.
 *
 * It lives here — in the module both sides already share for lane control —
 * rather than beside either caller, because `src/cli/` must not import from
 * `src/hooks/`, and because the two paths sending *different* text would be an
 * invisible inconsistency in what a resumed lane is told.
 *
 * The text deliberately adds no task instructions: the lane's session survived
 * the abort intact, so its original prompt, plan and tool history are all
 * still in context, and anything added here would compete with them.
 *
 * The one thing it must say is the thing the lane cannot know: an abort can
 * land MID-operation, so the last tool call it remembers issuing may have
 * completed, partially completed, or never run. Re-doing an `edit` or a
 * migration blind is the one way a resume can be worse than a relaunch.
 */
export const RESUME_PROMPT_TEXT =
  'You were interrupted by an abort. Continue your original task from where you left off; your earlier instructions still stand. Before repeating any file edit or command you were in the middle of, re-check its current state first. Finish with the same final report format.';

/** What a recorded CLI action was. */
export type LaneIntentAction = 'stop' | 'revive';

/** One user action taken from the CLI, recorded for the plugin to interpret. */
export interface LaneIntent {
  at: number;
  action: LaneIntentAction;
  sessionID: string;
  reason?: string;
}

const LANE_INTENT_ACTIONS: ReadonlySet<string> = new Set<LaneIntentAction>([
  'stop',
  'revive',
]);

export function serverInfoPath(directory: string): string {
  return path.join(laneStateDir(), `${laneStateKey(directory)}.server.json`);
}

export function laneIntentsPath(directory: string): string {
  return path.join(laneStateDir(), `${laneStateKey(directory)}.intents.jsonl`);
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Partial<ServerInfo>;
  return (
    typeof info.url === 'string' &&
    info.url.length > 0 &&
    typeof info.directory === 'string' &&
    typeof info.pid === 'number'
  );
}

/** Read the sidecar. `undefined` for missing, unreadable or invalid files. */
export function readServerInfo(file: string): ServerInfo | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isServerInfo(parsed)) return undefined;
    return {
      url: parsed.url,
      directory: parsed.directory,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Atomic sidecar write (tmp + rename), so a CLI reading concurrently either
 * sees the previous record or the new one, never a truncated JSON body.
 *
 * Returns false instead of throwing: an unwritable data dir must not break
 * plugin startup, it just means the CLI will ask for `--server`.
 */
export function writeServerInfo(file: string, info: ServerInfo): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(info), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch (error) {
    log('[lane-control] server sidecar write failed', {
      file,
      error: String(error),
    });
    try {
      unlinkSync(tmp);
    } catch {
      // A leftover tmp file is never read; best effort only.
    }
    return false;
  }
}

export function removeServerInfo(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Nothing actionable: a stale sidecar is handled by readers.
  }
}

export interface ServerSidecarOptions {
  directory: string;
  /** Re-resolved on every refresh: the host may populate it late. */
  resolveServerUrl: () => string | null;
  enabled: boolean;
  /** Test seams. */
  file?: string;
  now?: () => number;
  pid?: number;
  refreshIntervalMs?: number;
  minWriteIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface ServerSidecar {
  readonly file: string;
  /**
   * Write (or rewrite) the record. Safe to call as often as you like: writes
   * are coalesced to at most one per `minWriteIntervalMs` unless forced.
   */
  refresh(options?: { force?: boolean }): void;
  /** Remove the record. */
  dispose(): void;
}

/**
 * Publish "this server owns this directory" for the CLI to find.
 *
 * Refreshed on a timer (unref'd, so it never holds the process open) and on
 * every mirror flush, so `updatedAt` doubles as a liveness heartbeat. On
 * disposal the file is removed outright — a missing sidecar produces a clear
 * "start OpenCode or pass --server" message, whereas a stale one would send
 * the CLI at a dead port (or, worse, a recycled one).
 */
export function createServerSidecar(
  options: ServerSidecarOptions,
): ServerSidecar {
  const file = options.file ?? serverInfoPath(options.directory);
  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? process.pid;
  const startInterval = options.setIntervalFn ?? setInterval;
  const stopInterval = options.clearIntervalFn ?? clearInterval;
  const refreshIntervalMs = options.refreshIntervalMs ?? SIDECAR_REFRESH_MS;
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? DEFAULT_SIDECAR_MIN_WRITE_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt: number | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let lastUrl: string | undefined;
  let disposed = false;

  function refresh(refreshOptions: { force?: boolean } = {}): void {
    if (!options.enabled || disposed) return;
    let url: string | null = null;
    try {
      url = options.resolveServerUrl();
    } catch {
      url = null;
    }
    // No URL yet is normal early in startup; the timer will try again.
    if (!url) return;
    const at = now();
    // A changed URL must land immediately (the CLI would otherwise talk to the
    // previous port); a mere heartbeat can wait for the floor.
    if (
      !refreshOptions.force &&
      url === lastUrl &&
      at - lastWriteAt < minWriteIntervalMs
    ) {
      return;
    }
    startedAt ??= at;
    lastWriteAt = at;
    lastUrl = url;
    writeServerInfo(file, {
      url,
      // Canonical (symlinks resolved), the same form `laneStateKey` hashes, so
      // the CLI's "is this sidecar about my directory?" check cannot be
      // defeated by two spellings of one path.
      directory: canonicalDirectory(options.directory),
      pid,
      startedAt,
      updatedAt: at,
    });
  }

  if (options.enabled) {
    refresh({ force: true });
    timer = startInterval(() => {
      refresh({ force: true });
    }, refreshIntervalMs);
    timer?.unref?.();
  }

  return {
    file,
    refresh,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        stopInterval(timer);
        timer = undefined;
      }
      if (options.enabled) removeServerInfo(file);
    },
  };
}

// ── Control intents (CLI → plugin) ────────────────────────────────────

/**
 * Record a user action before performing it.
 *
 * Order matters: the CLI appends BEFORE calling `abort`, because the plugin
 * observes the resulting `session.error(MessageAbortedError)` within
 * milliseconds and needs the explanation to already be on disk. A line written
 * afterwards would lose the race and the kill would be reported as an
 * anonymous error.
 *
 * Append-only JSONL: concurrent CLI invocations cannot corrupt each other, and
 * a partially written tail line is simply skipped by the reader.
 */
export function appendLaneIntent(file: string, intent: LaneIntent): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(intent)}\n`, 'utf8');
    return true;
  } catch (error) {
    log('[lane-control] intent append failed', {
      file,
      error: String(error),
    });
    return false;
  }
}

function parseIntent(line: string): LaneIntent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const intent = parsed as Partial<LaneIntent>;
    if (
      typeof intent.sessionID !== 'string' ||
      intent.sessionID.length === 0 ||
      typeof intent.at !== 'number' ||
      !Number.isFinite(intent.at) ||
      typeof intent.action !== 'string' ||
      !LANE_INTENT_ACTIONS.has(intent.action)
    ) {
      return undefined;
    }
    return {
      at: intent.at,
      action: intent.action,
      sessionID: intent.sessionID,
      reason: typeof intent.reason === 'string' ? intent.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse the intents file, dropping unparseable and expired lines.
 *
 * Reads at most {@link MAX_INTENTS_BYTES}: this runs on abort events, and a
 * pathological file must not turn one lane's death into a long synchronous
 * read. Every failure mode yields an empty list.
 *
 * `stale` reports whether anything was dropped, so the caller can skip a
 * pointless rewrite of a file that is already exactly right.
 */
function parseIntentsFile(
  file: string,
  now: number,
  retentionMs: number,
): { intents: LaneIntent[]; stale: boolean } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { intents: [], stale: false };
  }
  if (raw.length > MAX_INTENTS_BYTES) {
    // Keep the newest bytes; the leading partial line fails parseIntent.
    raw = raw.slice(raw.length - MAX_INTENTS_BYTES);
  }

  const intents: LaneIntent[] = [];
  let kept = 0;
  let total = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    const intent = parseIntent(line);
    if (!intent) continue;
    if (now - intent.at > retentionMs) continue;
    intents.push(intent);
    kept += 1;
  }
  return { intents, stale: kept !== total };
}

export function readLaneIntents(
  file: string,
  options: { now?: number; retentionMs?: number } = {},
): LaneIntent[] {
  return parseIntentsFile(
    file,
    options.now ?? Date.now(),
    options.retentionMs ?? INTENT_RETENTION_MS,
  ).intents;
}

/**
 * Claim the newest intent of `action` that explains an event on `sessionID`.
 *
 * "Claim" is literal: the matched line is removed from the file so a later
 * event of the same kind on the same lane (a genuine cascade after a user
 * cancel, or a second revive) cannot be mislabelled by a reused line.
 * Surviving lines are rewritten atomically, which also prunes everything
 * expired.
 *
 * Returns `undefined` when there is no recent matching intent — the normal
 * case, and the cheapest path (missing file → one failed `readFileSync`).
 */
export function consumeLaneIntent(
  file: string,
  sessionID: string,
  action: LaneIntentAction,
  options: { now?: number; withinMs?: number; retentionMs?: number } = {},
): LaneIntent | undefined {
  const now = options.now ?? Date.now();
  const withinMs = options.withinMs ?? STOP_INTENT_WINDOW_MS;
  const retentionMs = options.retentionMs ?? INTENT_RETENTION_MS;

  const { intents, stale } = parseIntentsFile(file, now, retentionMs);
  if (intents.length === 0) {
    if (stale) rewriteIntents(file, intents);
    return undefined;
  }

  let matchIndex = -1;
  for (let index = intents.length - 1; index >= 0; index--) {
    const intent = intents[index] as LaneIntent;
    if (intent.action !== action || intent.sessionID !== sessionID) continue;
    // Future-dated lines (clock skew between the two processes) still count as
    // "recent": the alternative is silently ignoring a real user action.
    if (now - intent.at > withinMs) continue;
    matchIndex = index;
    break;
  }
  if (matchIndex === -1) {
    // Nothing to claim. Only touch the file when the read actually pruned
    // something, so a normal abort costs one read and zero writes.
    if (stale) rewriteIntents(file, intents);
    return undefined;
  }

  const matched = intents[matchIndex] as LaneIntent;
  rewriteIntents(file, [
    ...intents.slice(0, matchIndex),
    ...intents.slice(matchIndex + 1),
  ]);
  return matched;
}

/** Claim the `stop` intent that explains an abort of `sessionID`, if any. */
export function consumeStopIntent(
  file: string,
  sessionID: string,
  options: { now?: number; withinMs?: number; retentionMs?: number } = {},
): LaneIntent | undefined {
  return consumeLaneIntent(file, sessionID, 'stop', options);
}

/**
 * Claim the `revive` intent that explains a busy signal on `sessionID`.
 *
 * Only ever consulted for a lane the board already holds as a settled,
 * retained record, so the normal busy path never touches the disk.
 *
 * A miss is not fatal but it is not free either: the session resumes regardless
 * (the CLI has already prompted it), but the run is not handed to the
 * revived-run tracker, so the board keeps showing the lane as interrupted and
 * the parent is never told how the resumed run ended. The CLI says so when it
 * fails to record the line.
 */
export function consumeReviveIntent(
  file: string,
  sessionID: string,
  options: { now?: number; withinMs?: number; retentionMs?: number } = {},
): LaneIntent | undefined {
  return consumeLaneIntent(file, sessionID, 'revive', {
    withinMs: REVIVE_INTENT_WINDOW_MS,
    ...options,
  });
}

/**
 * Rewrite the intents file with exactly `intents`.
 *
 * Atomic, and best-effort: if it fails, the worst case is that an already
 * consumed intent is seen twice, which only affects a kill *label*.
 */
function rewriteIntents(file: string, intents: LaneIntent[]): void {
  try {
    if (intents.length === 0) {
      rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    const body = `${intents.map((intent) => JSON.stringify(intent)).join('\n')}\n`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch {
    // Leave the file as-is; duplicate labelling is harmless.
  }
}
