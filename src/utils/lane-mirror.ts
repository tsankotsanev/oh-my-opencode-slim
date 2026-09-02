/**
 * JSON mirror of the Background Job Board, written for the `omos lanes` CLI.
 *
 * # This file is NOT a truth source. Ever.
 *
 * The plugin reconstructs live lanes from the orchestrator's own transcript
 * (`rehydrateHistoricalRunningTasks` in
 * `src/hooks/task-session-manager/index.ts`) plus the runtime status poller.
 * That is the only recovery path, and it is the reason this module has a
 * writer and a reader that live in *different processes*:
 *
 * | file                    | writer | reader | purpose                       |
 * |-------------------------|--------|--------|-------------------------------|
 * | `<key>.json`            | plugin | CLI    | lane list for a second shell  |
 * | `<key>.server.json`     | plugin | CLI    | which server owns this dir    |
 * | `<key>.intents.jsonl`   | CLI    | plugin | why a lane was just aborted   |
 *
 * The plugin never reads `<key>.json` back. Importing this mirror into the
 * board would resurrect records the board deliberately pruned, contradict the
 * transcript rehydration, and give two processes a shared mutable truth. The
 * CLI, symmetrically, never writes it. Both directions are enforced by
 * inspection only, so keep them intact: there is no lock, and the whole design
 * relies on exactly one writer per file.
 *
 * Hard rules:
 * - I/O failures NEVER propagate: every entry point logs and continues. A
 *   broken disk must not break orchestration.
 * - Writes are debounced (at most one per `minWriteIntervalMs`, default 1s)
 *   and atomic (tmp file + rename), so a CLI reading concurrently sees either
 *   the previous mirror or the new one, never a truncated body.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Type-only: the CLI imports this module to READ the mirror and must not ship
// the board class (and, through it, the orchestrator's prompt rendering).
import type {
  BackgroundJobRecord,
  BackgroundJobState,
  CascadeStamp,
  LaneProgress,
} from './background-job-board';
import { log } from './logger';
import type { TaskOutputState } from './task';

/** Bumped whenever a field the CLI relies on changes meaning. */
export const LANE_MIRROR_VERSION = 1;

/** At most one write per second. */
const DEFAULT_MIN_WRITE_INTERVAL_MS = 1_000;

/**
 * One lane, as much of it as a second terminal needs.
 *
 * A deliberately narrow projection of {@link BackgroundJobRecord}: leases,
 * generations, context files and cache bookkeeping are the in-process board's
 * business, and publishing them would invite a reader to make decisions the
 * mirror cannot support.
 */
export interface LaneMirrorRecord {
  alias: string;
  /** Session id of the lane. Identical to the board's `taskID`. */
  sessionID: string;
  parentSessionID: string;
  agent: string;
  /** Short label; `objective` carries the fuller text when available. */
  label: string;
  objective?: string;
  state: BackgroundJobState;
  statusUncertain: boolean;
  /**
   * The orchestrator's own cancellation path owns this run.
   *
   * Published because it is a refusal input for the CLI, exactly as it is for
   * `task_message`: a lane whose cancellation lease is held must not be
   * prompted from a second terminal.
   */
  cancellationRequested: boolean;
  /** True while the parent has not yet been told about a terminal outcome. */
  terminalUnreconciled: boolean;
  lastStatusError?: string;
  resultSummary?: string;
  lastProgress?: LaneProgress;
  /**
   * Set while a permission prompt for this lane is open.
   *
   * Deliberately narrower than the board's `AwaitingPermission`: the request id
   * exists to fence the plugin's own clear and is of no use to a reader, so it
   * is stripped rather than published.
   */
  awaitingPermission?: { tool: string; at: number };
  /** Set when a `omos lanes stop` was attributed to this lane's abort. */
  cancelledByUser?: { at: number; reason?: string };
  /**
   * Set when this lane's death was attributed to an ESC on the orchestrator.
   *
   * Published whole rather than as a boolean because `at` is the cascade's
   * identity: `omos lanes revive --cascade` selects the group with the newest
   * `at`, which is the only way "undo the ESC I just pressed" can be expressed
   * offline.
   */
  killedByCascade?: CascadeStamp;
  /** Set while the current run is one the user resumed from the CLI. */
  revivedByUser?: { at: number };
  /**
   * Outcome carried by a `reconciled` record.
   *
   * Published so the CLI's revivability check (`isReviveableRetainedJob`) can
   * be the SAME predicate `task_revive` applies, rather than a lookalike that
   * silently disagrees about reconciled lanes.
   */
  terminalState?: TaskOutputState;
  launchedAt: number;
  updatedAt: number;
}

export interface LaneMirrorSnapshot {
  version: number;
  savedAt: number;
  /** Canonical directory this mirror describes (symlinks resolved). */
  directory: string;
  /**
   * Lanes as an ARRAY, not an alias-keyed object: aliases are unique per
   * PARENT session, so two orchestrator sessions in one directory can each
   * own a `fix-1`. Keying by alias would silently drop one of them; the CLI
   * instead resolves and reports the ambiguity.
   */
  lanes: LaneMirrorRecord[];
}

/**
 * Storage root, matching the convention already used by the companion
 * subsystem (`src/companion/manager.ts`): XDG_DATA_HOME when absolute,
 * otherwise `~/.local/share`, then `opencode/storage/oh-my-opencode-slim`.
 */
function storageRoot(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'storage', 'oh-my-opencode-slim');
}

/**
 * Directory holding every per-project lane artefact (board mirror, server
 * sidecar, control intents).
 *
 * Exported so the `omos lanes` CLI resolves exactly the same location the
 * plugin writes to — a second implementation of this path would silently
 * diverge the moment either side changed.
 */
export function laneStateDir(): string {
  return path.join(storageRoot(), 'background-jobs');
}

/**
 * Canonical form of a project directory, for hashing.
 *
 * `path.resolve` alone is not enough: the plugin is handed whatever
 * `ctx.directory` the host computed while the CLI starts from the user's cwd
 * or `--dir`, and on macOS those routinely differ by a symlink (`/tmp` →
 * `/private/tmp`, and any project reached through a symlinked parent). Two
 * spellings of one directory would hash to two different mirrors, so the CLI
 * would report "no lanes" for a project that has plenty.
 *
 * `realpathSync.native` resolves every symlink but throws when the path does
 * not exist — legitimate here (a `--dir` typo, or a directory removed after
 * the server started), so it falls back to `path.resolve`.
 */
export function canonicalDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Stable per-directory key: the first 16 hex chars of the sha256 of the
 * canonicalized path. Both the plugin and the CLI go through this one
 * function, so any two spellings of the same directory agree.
 */
export function laneStateKey(directory: string): string {
  return createHash('sha256')
    .update(canonicalDirectory(directory))
    .digest('hex')
    .slice(0, 16);
}

/**
 * One mirror file per project directory, keyed by a hash of the resolved
 * directory so two projects never share (or clobber) a lane list.
 */
export function laneMirrorPath(directory: string): string {
  return path.join(laneStateDir(), `${laneStateKey(directory)}.json`);
}

/**
 * Cap on free-text fields copied into the mirror.
 *
 * `objective` is a slice of the original task prompt and `resultSummary` can
 * carry a whole provider error, so both are unbounded in principle. The mirror
 * is a listing, not an archive: the CLI truncates these for display anyway,
 * and `omos lanes show` reads the real transcript from the server when the full
 * text matters. Keeping the file small also keeps a once-per-second atomic
 * rewrite cheap.
 */
const MIRROR_TEXT_LIMIT = 300;

function mirrorText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= MIRROR_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, MIRROR_TEXT_LIMIT - 1)}\u2026`;
}

/** Project the in-process record onto the narrow mirror shape. */
export function toLaneMirrorRecord(job: BackgroundJobRecord): LaneMirrorRecord {
  const objective = mirrorText(job.objective);
  const lastStatusError = mirrorText(job.lastStatusError);
  const resultSummary = mirrorText(job.resultSummary);
  return {
    alias: job.alias,
    sessionID: job.taskID,
    parentSessionID: job.parentSessionID,
    agent: job.agent,
    label: mirrorText(job.description) ?? '',
    ...(objective ? { objective } : {}),
    state: job.state,
    statusUncertain: job.statusUncertain,
    cancellationRequested: job.cancellationRequested,
    terminalUnreconciled: job.terminalUnreconciled,
    ...(lastStatusError ? { lastStatusError } : {}),
    ...(resultSummary ? { resultSummary } : {}),
    ...(job.lastProgress ? { lastProgress: job.lastProgress } : {}),
    ...(job.awaitingPermission
      ? {
          awaitingPermission: {
            tool: job.awaitingPermission.tool,
            at: job.awaitingPermission.at,
          },
        }
      : {}),
    ...(job.cancelledByUser ? { cancelledByUser: job.cancelledByUser } : {}),
    ...(job.killedByCascade ? { killedByCascade: job.killedByCascade } : {}),
    ...(job.revivedByUser ? { revivedByUser: job.revivedByUser } : {}),
    ...(job.terminalState ? { terminalState: job.terminalState } : {}),
    launchedAt: job.launchedAt,
    updatedAt: job.updatedAt,
  };
}

function isMirrorSnapshot(value: unknown): value is LaneMirrorSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<LaneMirrorSnapshot>;
  return (
    snapshot.version === LANE_MIRROR_VERSION && Array.isArray(snapshot.lanes)
  );
}

/**
 * Read a mirror. Returns undefined for missing, unreadable or invalid files.
 *
 * A version mismatch is treated as "no mirror" rather than as an error: after
 * an upgrade the plugin rewrites it within a second of the next board change.
 */
export function readLaneMirror(file: string): LaneMirrorSnapshot | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log('[lane-mirror] read failed', { file, error: String(error) });
    }
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isMirrorSnapshot(parsed)) {
      log('[lane-mirror] rejected (shape/version mismatch)', { file });
      return undefined;
    }
    return parsed;
  } catch (error) {
    log('[lane-mirror] parse failed', { file, error: String(error) });
    return undefined;
  }
}

/**
 * Atomic write: serialize to a pid-scoped tmp file then rename over the
 * target, so a reader never observes a partially written mirror.
 */
export function writeLaneMirror(
  file: string,
  snapshot: LaneMirrorSnapshot,
): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch (error) {
    log('[lane-mirror] write failed', { file, error: String(error) });
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: a leftover tmp file is harmless (never read).
    }
    return false;
  }
}

export interface LaneMirrorOptions {
  /** Current lanes. Read once per flush, only when a flush is due. */
  lanes: () => BackgroundJobRecord[];
  directory: string;
  enabled: boolean;
  /**
   * Called at the start of a flush, before the board is read.
   *
   * For last-moment bookkeeping that should be visible in the file being
   * written (claiming pending CLI stop intents). Runs at most once per
   * `minWriteIntervalMs`, so it is a safe place for one small disk read that
   * would be far too expensive on the event path. Must not throw; failures
   * are swallowed.
   */
  onBeforeFlush?: () => void;
  /**
   * Called after a flush.
   *
   * Used to piggyback the server sidecar's heartbeat on the mirror's own
   * cadence instead of giving it a second timer. Note that a flush means "the
   * plugin looked", not "something changed" — it fires even when the write is
   * skipped as a no-op. Must not throw; failures are swallowed.
   */
  onFlush?: () => void;
  /** Test seams. */
  file?: string;
  now?: () => number;
  minWriteIntervalMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface LaneMirror {
  /** Absolute mirror path (useful for logs and tests). */
  readonly file: string;
  /** Debounced flush; safe to call on every event. */
  scheduleFlush(): void;
  /** Flush immediately, cancelling any pending debounce. */
  flushNow(): void;
  /** Flush once more, then stop scheduling. */
  dispose(): void;
}

/**
 * Live lane-control writers per project directory.
 *
 * The plugin factory re-runs on every config update, so a long-lived server
 * builds several hook generations for one directory. Without this registry the
 * previous generation's mirror timer and sidecar heartbeat keep running
 * against a board nobody reads any more, and both generations race the same
 * two files. Module-level (not per-hook) precisely because the new generation
 * has no reference to the old one.
 */
const laneWritersByDirectory = new Map<string, () => void>();

/**
 * Dispose the lane-control writers a previous plugin generation left running
 * for `directory`, and register `dispose` as the current owner.
 *
 * Returns nothing and never throws: a failed teardown of a dead generation
 * must not stop the new one from starting.
 */
export function claimLaneWriters(directory: string, dispose: () => void): void {
  const key = canonicalDirectory(directory);
  const previous = laneWritersByDirectory.get(key);
  laneWritersByDirectory.set(key, dispose);
  if (!previous) return;
  try {
    previous();
  } catch (error) {
    log('[lane-mirror] previous generation teardown failed', {
      directory: key,
      error: String(error),
    });
  }
}

/** Forget the current owner for `directory` (called from its own dispose). */
export function releaseLaneWriters(
  directory: string,
  dispose: () => void,
): void {
  const key = canonicalDirectory(directory);
  if (laneWritersByDirectory.get(key) === dispose) {
    laneWritersByDirectory.delete(key);
  }
}

/**
 * Wire the board to its CLI-facing mirror.
 *
 * When `enabled` is false every method is a no-op, so callers do not branch on
 * the config flag. There is no `load()`: see the module header — reading this
 * file back into the plugin is the one thing the design forbids.
 */
export function createLaneMirror(options: LaneMirrorOptions): LaneMirror {
  const file = options.file ?? laneMirrorPath(options.directory);
  const now = options.now ?? (() => Date.now());
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? DEFAULT_MIN_WRITE_INTERVAL_MS;
  const schedule = options.setTimeoutFn ?? setTimeout;
  const cancel = options.clearTimeoutFn ?? clearTimeout;
  const directory = canonicalDirectory(options.directory);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  /** Serialized body of the last write, minus `savedAt`, for no-op detection. */
  let lastBody: string | undefined;
  /** When the published content last actually changed. */
  let lastChangedAt = 0;
  let dirty = false;
  let disposed = false;

  function write(): void {
    dirty = false;
    const at = now();
    lastWriteAt = at;
    try {
      options.onBeforeFlush?.();
    } catch {
      // Bookkeeping must never break the mirror write path.
    }
    let lanes: BackgroundJobRecord[] = [];
    try {
      lanes = options.lanes();
    } catch (error) {
      log('[lane-mirror] snapshot failed', { file, error: String(error) });
      return;
    }

    const records = lanes.map(toLaneMirrorRecord);
    // Compare the content WITHOUT the timestamp, then stamp the file with the
    // moment the content last changed. A flush is scheduled by events, most of
    // which do not touch any lane, so most flushes have nothing new to say;
    // rewriting the same bytes with a fresh `savedAt` would burn a syscall per
    // second and make every reader think the board had just moved.
    const body = JSON.stringify({
      version: LANE_MIRROR_VERSION,
      directory,
      lanes: records,
    });
    if (body !== lastBody) {
      lastBody = body;
      lastChangedAt = at;
      writeLaneMirror(file, {
        version: LANE_MIRROR_VERSION,
        savedAt: lastChangedAt,
        directory,
        lanes: records,
      });
    }

    try {
      options.onFlush?.();
    } catch {
      // Sidecar bookkeeping must never break the mirror write path.
    }
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  }

  function scheduleFlush(): void {
    if (!options.enabled || disposed) return;
    dirty = true;
    if (timer !== undefined) return;

    const elapsed = now() - lastWriteAt;
    if (elapsed >= minWriteIntervalMs) {
      write();
      return;
    }
    timer = schedule(() => {
      timer = undefined;
      if (disposed || !dirty) return;
      write();
    }, minWriteIntervalMs - elapsed);
    timer?.unref?.();
  }

  return {
    file,
    scheduleFlush,

    flushNow(): void {
      if (!options.enabled || disposed) return;
      clearTimer();
      write();
    },

    dispose(): void {
      if (disposed) return;
      clearTimer();
      // One final flush regardless of the debounce state: board changes do not
      // all arrive with an event behind them, so "nothing is dirty" does not
      // prove the file matches the board. The last thing a CLI reads after the
      // server exits should be the truth as of shutdown. The no-op check still
      // applies, so an unchanged mirror is left exactly as it is.
      if (options.enabled) write();
      disposed = true;
    },
  };
}
