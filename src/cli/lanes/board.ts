/**
 * Read-only view of the lane mirror for the `omos lanes` CLI.
 *
 * The CLI is a SECOND process: the in-memory Background Job Board inside the
 * OpenCode server is the source of truth and this file is a convenience copy
 * of it. This module therefore only ever reads — writing the mirror from here
 * would make two processes race over a file the plugin owns, and could
 * resurrect records the plugin deliberately pruned.
 *
 * It reuses `laneMirrorPath`/`readLaneMirror` from the plugin rather than
 * re-deriving the path or the schema check, because a divergence there is
 * exactly the kind of bug nobody notices until the CLI silently reports an
 * empty list. That import is type-safe and cheap: `src/utils/lane-mirror.ts`
 * pulls in nothing but `node:fs`, `node:crypto` and the logger.
 */

import {
  type LaneMirrorRecord,
  laneMirrorPath,
  readLaneMirror,
} from '../../utils/lane-mirror';

export interface LaneBoard {
  /** Absolute mirror path, always reported so the user can inspect it. */
  file: string;
  exists: boolean;
  savedAt?: number;
  lanes: LaneMirrorRecord[];
}

/**
 * Load the mirror for `directory`.
 *
 * A missing file is a normal, expected state (no orchestrator has dispatched a
 * lane here yet, or `backgroundJobs.laneControl` is off), so it is reported as
 * `exists: false` rather than an error.
 */
export function loadLaneBoard(directory: string, file?: string): LaneBoard {
  const target = file ?? laneMirrorPath(directory);
  const snapshot = readLaneMirror(target);
  if (!snapshot) {
    return { file: target, exists: false, lanes: [] };
  }
  const lanes = snapshot.lanes.filter(
    (lane): lane is LaneMirrorRecord =>
      typeof lane === 'object' &&
      lane !== null &&
      typeof lane.sessionID === 'string' &&
      lane.sessionID.length > 0,
  );
  return {
    file: target,
    exists: true,
    savedAt: snapshot.savedAt,
    // Newest launch last, matching the board's own ordering.
    lanes: [...lanes].sort((a, b) => (a.launchedAt ?? 0) - (b.launchedAt ?? 0)),
  };
}

export type LaneResolution =
  | { kind: 'ok'; lane: LaneMirrorRecord }
  | { kind: 'not-found'; selector: string }
  | { kind: 'ambiguous'; selector: string; matches: LaneMirrorRecord[] };

/**
 * Resolve a user-typed selector to exactly one lane.
 *
 * Order matters: an exact session id wins over an alias, because a raw `ses_…`
 * is unambiguous by construction while aliases are only unique *per parent
 * session*. Two orchestrator sessions in the same directory can each own a
 * `fix-1`, and guessing between them could abort the wrong lane — so that case
 * is reported as ambiguous with both session ids, never resolved by a
 * heuristic.
 */
export function resolveLane(
  lanes: LaneMirrorRecord[],
  selector: string,
): LaneResolution {
  const value = selector.trim();
  if (!value) return { kind: 'not-found', selector };

  const byId = lanes.filter((lane) => lane.sessionID === value);
  if (byId.length === 1)
    return { kind: 'ok', lane: byId[0] as LaneMirrorRecord };

  const byAlias = lanes.filter((lane) => lane.alias === value);
  if (byAlias.length === 1) {
    return { kind: 'ok', lane: byAlias[0] as LaneMirrorRecord };
  }
  if (byAlias.length > 1) {
    return { kind: 'ambiguous', selector: value, matches: byAlias };
  }

  return { kind: 'not-found', selector: value };
}

/** True when `sessionID` is the parent of any lane in the mirror. */
export function isKnownParentSession(
  lanes: LaneMirrorRecord[],
  sessionID: string,
): boolean {
  return lanes.some((lane) => lane.parentSessionID === sessionID);
}
