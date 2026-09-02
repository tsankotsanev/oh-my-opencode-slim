/**
 * JSON mirror of the Background Job Board, written for the `omo lanes` CLI.
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
  LaneProgress,
} from './background-job-board';
import { log } from './logger';

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
  /** True while the parent has not yet been told about a terminal outcome. */
  terminalUnreconciled: boolean;
  lastStatusError?: string;
  resultSummary?: string;
  lastProgress?: LaneProgress;
  /** Set while a permission prompt for this lane is open. */
  awaitingPermission?: { tool: string; at: number };
  /** Set when a `omo lanes stop` was attributed to this lane's abort. */
  cancelledByUser?: { at: number; reason?: string };
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
 * Exported so the `omo lanes` CLI resolves exactly the same location the
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

/** Project the in-process record onto the narrow mirror shape. */
export function toLaneMirrorRecord(job: BackgroundJobRecord): LaneMirrorRecord {
  return {
    alias: job.alias,
    sessionID: job.taskID,
    parentSessionID: job.parentSessionID,
    agent: job.agent,
    label: job.description,
    ...(job.objective ? { objective: job.objective } : {}),
    state: job.state,
    statusUncertain: job.statusUncertain,
    terminalUnreconciled: job.terminalUnreconciled,
    ...(job.lastStatusError ? { lastStatusError: job.lastStatusError } : {}),
    ...(job.resultSummary ? { resultSummary: job.resultSummary } : {}),
    ...(job.lastProgress ? { lastProgress: job.lastProgress } : {}),
    ...(job.awaitingPermission
      ? { awaitingPermission: job.awaitingPermission }
      : {}),
    ...(job.cancelledByUser ? { cancelledByUser: job.cancelledByUser } : {}),
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
  /** Current lanes. Called only when a write actually happens. */
  lanes: () => BackgroundJobRecord[];
  directory: string;
  enabled: boolean;
  /**
   * Called after every mirror write. Used to piggyback the server sidecar's
   * heartbeat on an event that already means "the board changed", instead of
   * giving the sidecar its own change feed. Must not throw; failures are
   * swallowed.
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
  /** Debounced write; safe to call on every event. */
  scheduleFlush(): void;
  /** Write immediately, cancelling any pending debounce. */
  flushNow(): void;
  /** Flush anything pending and stop scheduling. */
  dispose(): void;
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
  let dirty = false;
  let disposed = false;

  function write(): void {
    dirty = false;
    lastWriteAt = now();
    let lanes: BackgroundJobRecord[] = [];
    try {
      lanes = options.lanes();
    } catch (error) {
      log('[lane-mirror] snapshot failed', { file, error: String(error) });
      return;
    }
    writeLaneMirror(file, {
      version: LANE_MIRROR_VERSION,
      savedAt: lastWriteAt,
      directory,
      lanes: lanes.map(toLaneMirrorRecord),
    });
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
      // One unconditional final write, not just a pending-flush: board changes
      // do not all arrive with an event behind them, so "nothing is dirty"
      // does not prove the file matches the board. The last thing a CLI reads
      // after the server exits should be the truth as of shutdown.
      if (options.enabled) write();
      disposed = true;
    },
  };
}
