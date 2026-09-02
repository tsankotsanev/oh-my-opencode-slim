/**
 * The four `omos lanes` commands.
 *
 * All state-changing calls go straight to the OpenCode server over the SDK —
 * never through the orchestrator model — which is the entire point: the user
 * gets to inspect, steer and stop lanes for zero tokens.
 *
 * Three rules are enforced here and must not be relaxed. The first and the
 * last are measured (`docs/agents/subagent-probe-results.md`); the middle one
 * is read off core's own `createUserMessage`:
 *
 *   A2 — `promptAsync` MUST carry the target session's own `agent`. Omitting
 *        it rewrites `session.agent` to `build` immediately on accept, which
 *        silently converts a specialist child into a generic build session.
 *        `say` therefore refuses to run when it cannot prove the agent from
 *        the mirror, rather than guessing.
 *   MODEL — `promptAsync` must ALSO carry the session's live model.
 *        `createUserMessage` resolves `input.model ?? agent.model ??
 *        currentModel(session)`, so the agent's CONFIGURED model outranks the
 *        session's current one: an agent-only body silently re-pins a lane
 *        that foreground fallback had moved off its primary straight back onto
 *        the model that was failing it, variant reset included. Probe A1
 *        passed `model` for exactly this reason. `say` reads the live model
 *        and refuses (like `task_message`) when it cannot establish one.
 *   B2 — `abort(child)` does NOT touch the parent, but is completely silent to
 *        it. The plugin turns the resulting `session.error` into a terminal
 *        board record (and, for a revived run, synthesizes the parent
 *        notification), so `stop` does not need to notify anyone — it only has
 *        to leave the *reason* behind, which is what the intent line is for.
 */

import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../../utils/continuation-model-selection';
import { appendLaneIntent, laneIntentsPath } from '../../utils/lane-control';
import type { LaneMirrorRecord } from '../../utils/lane-mirror';
import { withAgent } from '../../utils/prompt-agent';
import { isKnownParentSession, loadLaneBoard, resolveLane } from './board';
import {
  describeSdkError,
  discoverServer,
  isConnectionError,
  type LaneClient,
  type LaneSdkResponse,
} from './server';

export interface LanesIO {
  out(line: string): void;
  err(line: string): void;
}

export interface LanesDeps extends LanesIO {
  createClient(url: string, directory: string): Promise<LaneClient>;
  now?: () => number;
  /** Test seams. */
  boardFile?: string;
  sidecarFile?: string;
  intentsFile?: string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  /** Sidecar liveness probe; defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Upper bound on the post-abort idle verification. */
  abortVerifyMs?: number;
}

const DEFAULT_ABORT_VERIFY_MS = 5_000;
const ABORT_POLL_INTERVAL_MS = 250;
const OBJECTIVE_WIDTH = 60;

type LaneLiveness = 'idle' | 'busy' | 'retry' | 'unknown';

function truncate(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= width) return normalized;
  return `${normalized.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Human-friendly age. Only ever applied to CLI output — the board's own prompt
 * rendering deliberately has no wall-clock ages (prompt-cache safety), but a
 * terminal the user is reading right now should say "3m ago".
 */
function formatAge(from: number | undefined, now: number): string {
  if (!from || !Number.isFinite(from)) return 'unknown';
  const ms = Math.max(0, now - from);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h${rest}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * One-line state label.
 *
 * `statusUncertain` is the plugin's way of saying "this record may not match
 * reality" — a lane that reports busy while emitting nothing, a lane whose
 * status lookup failed, or one whose stop is inside its confirmation grace.
 * It matters enough to every command's refusal logic that it is always shown.
 */
function laneStateLabel(lane: LaneMirrorRecord): string {
  const notes = [
    lane.statusUncertain ? 'status uncertain' : undefined,
    lane.cancelledByUser ? 'stopped by you' : undefined,
    lane.terminalUnreconciled && lane.state !== 'running'
      ? 'not yet reported to the orchestrator'
      : undefined,
  ].filter(Boolean);
  return notes.length > 0 ? `${lane.state} (${notes.join(', ')})` : lane.state;
}

function laneWaitingLabel(lane: LaneMirrorRecord): string | undefined {
  if (lane.state !== 'running') return undefined;
  const waiting = lane.awaitingPermission;
  return waiting ? `permission for ${waiting.tool}` : undefined;
}

// ── list ──────────────────────────────────────────────────────────────

export function runLanesList(
  directory: string,
  json: boolean,
  deps: LanesDeps,
): number {
  const now = deps.now?.() ?? Date.now();
  const board = loadLaneBoard(directory, deps.boardFile);

  if (json) {
    deps.out(
      JSON.stringify(
        {
          directory,
          file: board.file,
          exists: board.exists,
          savedAt: board.savedAt,
          lanes: board.lanes.map((lane) => ({
            alias: lane.alias,
            sessionID: lane.sessionID,
            parentSessionID: lane.parentSessionID,
            agent: lane.agent,
            state: lane.state,
            statusUncertain: lane.statusUncertain,
            terminalUnreconciled: lane.terminalUnreconciled,
            cancelledByUser: lane.cancelledByUser,
            objective: lane.objective ?? lane.label,
            awaitingPermission: lane.awaitingPermission,
            lastStatusError: lane.lastStatusError,
            resultSummary: lane.resultSummary,
            lastSeen: lane.lastProgress?.text,
            lastTool: lane.lastProgress?.lastTool,
            messageCount: lane.lastProgress?.messageCount,
            updatedAt: lane.updatedAt,
            launchedAt: lane.launchedAt,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!board.exists) {
    deps.out(`No lane mirror recorded for ${directory}.`);
    deps.out(`Expected: ${board.file}`);
    deps.out('');
    deps.out(
      'This is normal if no orchestrator has dispatched a background lane in',
    );
    deps.out(
      'this directory yet. If lanes ARE running, check that the plugin is',
    );
    deps.out(
      'loaded and backgroundJobs.laneControl is not false, and that --dir',
    );
    deps.out('points at the project root OpenCode was started from.');
    return 0;
  }

  if (board.lanes.length === 0) {
    deps.out(`No lanes recorded for ${directory}.`);
    deps.out(`Mirror: ${board.file} (saved ${formatAge(board.savedAt, now)})`);
    return 0;
  }

  deps.out(`Lanes for ${directory}`);
  deps.out(`Mirror: ${board.file} (saved ${formatAge(board.savedAt, now)})`);
  deps.out('');

  for (const lane of board.lanes) {
    deps.out(
      `${lane.alias}  ${lane.agent}  ${laneStateLabel(lane)}  (updated ${formatAge(
        lane.updatedAt,
        now,
      )})`,
    );
    deps.out(
      `  ${truncate(lane.objective || lane.label || '(no objective)', OBJECTIVE_WIDTH)}`,
    );
    const waiting = laneWaitingLabel(lane);
    if (waiting) deps.out(`  Waiting: ${waiting}`);
    if (lane.statusUncertain && lane.lastStatusError) {
      deps.out(`  Status: ${truncate(lane.lastStatusError, 100)}`);
    }
    const progress = lane.lastProgress;
    if (progress) {
      const facts = [
        progress.lastTool
          ? `last tool: ${progress.lastTool.name} ${progress.lastTool.status}`
          : undefined,
        `${progress.messageCount} msgs`,
      ].filter(Boolean);
      const text = progress.text ? `${truncate(progress.text, 80)} ` : '';
      deps.out(`  Last seen: ${text}(${facts.join(', ')})`);
    }
    deps.out(`  ${lane.sessionID}`);
    deps.out('');
  }

  deps.out(
    'Next: omos lanes show <alias> | omos lanes say <alias> "…" | omos lanes stop <alias>',
  );
  return 0;
}

// ── shared resolution for the server-backed commands ──────────────────

interface ResolvedTarget {
  lane?: LaneMirrorRecord;
  sessionID: string;
  client: LaneClient;
  serverUrl: string;
}

/**
 * Resolve selector → session id and open a client.
 *
 * A raw `ses_…` is accepted even when the mirror has no record of it: the
 * mirror can legitimately lag (lane control disabled, a lane launched by
 * another tool), and refusing to act on an id the user read off the screen
 * would be gratuitous. Commands that NEED mirror data (`say`, for the agent)
 * enforce that themselves.
 *
 * But a raw id is NOT allowed to be an orchestrator. `abort` cascades to the
 * whole session tree from either a busy or an idle parent (probes B1/B3), so
 * `omos lanes stop <parent-id>` would kill every lane at once from a command
 * that advertises itself as per-lane. Parent ids are easy to reach by
 * accident: `list --json` prints `parentSessionID` for every lane, and so does
 * the ambiguity error. Hence two checks:
 *
 *   1. the mirror — free, offline: refuse any selector that is a known
 *      `parentSessionID`;
 *   2. the server — one `session.get` for a raw id with no mirror record:
 *      require `parentID` to be set.
 *
 * `--force` overrides both, because a user who has read the message and still
 * wants a tree kill should not have to leave the CLI.
 */
async function resolveTarget(
  directory: string,
  selector: string,
  serverFlag: string | undefined,
  deps: LanesDeps,
  options: { force?: boolean; mutating?: boolean } = {},
): Promise<ResolvedTarget | number> {
  const board = loadLaneBoard(directory, deps.boardFile);
  const resolution = resolveLane(board.lanes, selector);

  let lane: LaneMirrorRecord | undefined;
  if (resolution.kind === 'ok') {
    lane = resolution.lane;
  } else if (resolution.kind === 'ambiguous') {
    deps.err(
      `"${selector}" matches ${resolution.matches.length} lanes in ${directory}:`,
    );
    for (const match of resolution.matches) {
      deps.err(
        `  ${match.alias}  ${match.agent}  ${match.state}  ${match.sessionID}  (parent ${match.parentSessionID})`,
      );
    }
    deps.err('Re-run with the full session id to pick one.');
    return 1;
  } else if (!selector.startsWith('ses_')) {
    deps.err(`No lane "${selector}" in ${directory}.`);
    if (board.lanes.length > 0) {
      deps.err(
        `Known lanes: ${board.lanes.map((entry) => entry.alias).join(', ')}`,
      );
    } else if (!board.exists) {
      deps.err(`No lane mirror recorded yet (${board.file}).`);
    }
    deps.err('Run "omos lanes list" to see what is available.');
    return 1;
  }

  const sessionID = lane?.sessionID ?? selector;

  // The orchestrator guards apply only to MUTATING commands. Reading an
  // orchestrator's transcript with `show` is harmless (and often what the user
  // actually wants), and it must not cost an extra round trip.
  const guard = options.mutating === true && options.force !== true;

  // Guard 1 (offline): the selector names an orchestrator this mirror knows.
  if (guard && !lane && isKnownParentSession(board.lanes, sessionID)) {
    reportOrchestratorTarget(deps, sessionID, board.lanes);
    return 1;
  }

  const opened = await openLaneClient(directory, serverFlag, deps);
  if (typeof opened === 'number') return opened;
  const { client, serverUrl } = opened;

  // Guard 2 (one round trip, raw ids only): a session the mirror has never
  // seen must prove it is a child before we touch it. Lanes resolved from the
  // mirror are children by construction — they were registered from a `task`
  // launch — so they skip this.
  if (guard && !lane) {
    const verdict = await verifyChildSession(
      client,
      sessionID,
      serverUrl,
      directory,
      deps,
    );
    if (verdict !== 0) return verdict;
  }

  // --force suppresses the refusal, not the fact. Say out loud what is about
  // to happen, so a forced tree kill is never a silent surprise.
  if (options.mutating === true && options.force === true && !lane) {
    await warnForcedTarget(client, sessionID, board.lanes, directory, deps);
  }

  return { lane, sessionID, client, serverUrl };
}

/** Discover the server and open one SDK client. */
async function openLaneClient(
  directory: string,
  serverFlag: string | undefined,
  deps: LanesDeps,
): Promise<{ client: LaneClient; serverUrl: string } | number> {
  const discovery = discoverServer(directory, {
    serverFlag,
    sidecarFile: deps.sidecarFile,
    env: deps.env,
    isProcessAlive: deps.isProcessAlive,
    now: deps.now,
  });
  if (!discovery.ok) {
    deps.err(discovery.message);
    return 1;
  }

  try {
    return {
      client: await deps.createClient(discovery.target.url, directory),
      serverUrl: discovery.target.url,
    };
  } catch (error) {
    deps.err(
      `Could not open a client for ${discovery.target.url}: ${describeSdkError(error)}`,
    );
    return 1;
  }
}

function reportOrchestratorTarget(
  deps: LanesDeps,
  sessionID: string,
  lanes: LaneMirrorRecord[],
): void {
  const owned = lanes.filter((lane) => lane.parentSessionID === sessionID);
  deps.err(
    `${sessionID} is an orchestrator session; aborting it kills all its lanes — use ESC in the TUI, or --force.`,
  );
  if (owned.length > 0) {
    deps.err(
      `It owns ${owned.length} lane${owned.length === 1 ? '' : 's'}: ${owned
        .map((lane) => lane.alias)
        .join(', ')}`,
    );
    deps.err('Target one of those aliases instead.');
  }
}

/**
 * One stderr line naming the blast radius of a forced non-lane target.
 *
 * The mirror answers for free when it knows the session as a parent (and can
 * even count the lanes). Otherwise one `session.get` establishes whether this
 * is a top-level session; a failed probe simply produces no warning, because
 * `--force` must not be blocked by a diagnostic.
 */
async function warnForcedTarget(
  client: LaneClient,
  sessionID: string,
  lanes: LaneMirrorRecord[],
  directory: string,
  deps: LanesDeps,
): Promise<void> {
  const owned = lanes.filter((lane) => lane.parentSessionID === sessionID);
  if (owned.length > 0) {
    deps.err(
      `Forcing: ${sessionID} is an orchestrator session — aborting it kills ${
        owned.length
      } lane${owned.length === 1 ? '' : 's'} (${owned
        .map((lane) => lane.alias)
        .join(', ')})`,
    );
    return;
  }

  let response: LaneSdkResponse | undefined;
  try {
    response = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
  } catch {
    return;
  }
  if (response?.error) return;
  const info = (
    response?.data && typeof response.data === 'object' ? response.data : {}
  ) as { parentID?: unknown };
  const hasParent =
    typeof info.parentID === 'string' && info.parentID.length > 0;
  if (hasParent) return;

  deps.err(
    `Forcing: ${sessionID} is a top-level session — aborting it kills all of its lanes`,
  );
}

/**
 * Confirm a raw session id is a background child (`parentID` set).
 *
 * Returns 0 to proceed, or an exit code. A session we cannot inspect is NOT
 * assumed safe: unknown parentage on a command that can kill a whole tree has
 * to fail closed.
 */
async function verifyChildSession(
  client: LaneClient,
  sessionID: string,
  serverUrl: string,
  directory: string,
  deps: LanesDeps,
): Promise<number> {
  let response: LaneSdkResponse;
  try {
    response = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
  } catch (error) {
    return reportUnreachable(deps, serverUrl, error);
  }
  if (response?.error) {
    if (response.response?.status === 404) {
      deps.err(`Session ${sessionID} does not exist on ${serverUrl}.`);
      deps.err(
        'Check the id, or point at the right server with --server (see "omos lanes list").',
      );
      return 1;
    }
    return reportUnreachable(deps, serverUrl, response.error);
  }

  const info = (
    response?.data && typeof response.data === 'object' ? response.data : {}
  ) as { parentID?: unknown };
  const parentID =
    typeof info.parentID === 'string' && info.parentID.length > 0
      ? info.parentID
      : undefined;

  if (!parentID) {
    deps.err(
      `${sessionID} is a top-level session, not a background lane; aborting it kills all its lanes — use ESC in the TUI, or --force.`,
    );
    deps.err('Run "omos lanes list" to see the lanes it owns.');
    return 1;
  }

  return 0;
}

function reportUnreachable(
  deps: LanesDeps,
  serverUrl: string,
  error: unknown,
): number {
  if (isConnectionError(error)) {
    deps.err(`Cannot reach the OpenCode server at ${serverUrl}.`);
    deps.err(
      'It may have exited since the sidecar was written. Restart OpenCode, or',
    );
    deps.err('pass the current URL with --server.');
    return 1;
  }
  deps.err(`Server rejected the request: ${describeSdkError(error)}`);
  return 1;
}

// ── show ──────────────────────────────────────────────────────────────

interface MessageView {
  role: string;
  agent?: string;
  text: string[];
  tools: Array<{ name: string; status: string }>;
  error?: string;
  finish?: string;
}

/** Flatten one SDK message record into the few facts worth printing. */
export function summarizeMessage(entry: unknown): MessageView | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as { info?: unknown; parts?: unknown };
  const info = (
    typeof record.info === 'object' && record.info !== null
      ? record.info
      : entry
  ) as {
    role?: unknown;
    agent?: unknown;
    error?: { name?: unknown; data?: { message?: unknown } };
    finish?: unknown;
  };
  const parts = Array.isArray(record.parts) ? record.parts : [];

  const view: MessageView = {
    role: typeof info.role === 'string' ? info.role : 'unknown',
    agent: typeof info.agent === 'string' ? info.agent : undefined,
    text: [],
    tools: [],
    finish: typeof info.finish === 'string' ? info.finish : undefined,
  };
  if (info.error && typeof info.error === 'object') {
    const name =
      typeof info.error.name === 'string' ? info.error.name : 'error';
    const message = info.error.data?.message;
    view.error = typeof message === 'string' ? `${name}: ${message}` : name;
  }

  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const shape = part as {
      type?: unknown;
      text?: unknown;
      tool?: unknown;
      state?: { status?: unknown };
      status?: unknown;
    };
    if (shape.type === 'text' && typeof shape.text === 'string') {
      const text = shape.text.trim();
      if (text) view.text.push(text);
      continue;
    }
    if (shape.type === 'tool') {
      const status =
        typeof shape.state?.status === 'string'
          ? shape.state.status
          : typeof shape.status === 'string'
            ? shape.status
            : 'unknown';
      view.tools.push({
        name: typeof shape.tool === 'string' ? shape.tool : 'tool',
        status,
      });
    }
  }

  return view;
}

export interface LanesTargetOptions {
  directory: string;
  selector: string;
  serverFlag?: string;
  json: boolean;
  force?: boolean;
}

export async function runLanesShow(
  args: LanesTargetOptions & { count: number },
  deps: LanesDeps,
): Promise<number> {
  const { directory, selector, serverFlag, json, count } = args;
  // Read-only: no orchestrator guard, no extra round trip.
  const resolved = await resolveTarget(directory, selector, serverFlag, deps);
  if (typeof resolved === 'number') return resolved;
  const { lane, sessionID, client, serverUrl } = resolved;

  let response: LaneSdkResponse;
  try {
    response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
  } catch (error) {
    return reportUnreachable(deps, serverUrl, error);
  }
  if (response?.error) {
    if (response.response?.status === 404) {
      deps.err(`Session ${sessionID} does not exist on ${serverUrl}.`);
      deps.err(
        'The lane may have been deleted, or this mirror belongs to a different server.',
      );
      return 1;
    }
    return reportUnreachable(deps, serverUrl, response.error);
  }

  const messages = Array.isArray(response?.data) ? response.data : [];
  const tail = messages.slice(Math.max(0, messages.length - count));

  if (json) {
    deps.out(
      JSON.stringify(
        {
          sessionID,
          alias: lane?.alias,
          agent: lane?.agent,
          state: lane?.state,
          serverUrl,
          totalMessages: messages.length,
          messages: tail.map(summarizeMessage),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const header = lane
    ? `${lane.alias} / ${lane.agent} / ${laneStateLabel(lane)}`
    : sessionID;
  deps.out(header);
  deps.out(`${sessionID}  ·  ${serverUrl}`);
  if (lane?.objective || lane?.label) {
    deps.out(`Objective: ${truncate(lane.objective || lane.label, 100)}`);
  }
  const waiting = lane ? laneWaitingLabel(lane) : undefined;
  if (waiting) deps.out(`Waiting: ${waiting}`);
  deps.out(
    `Showing ${tail.length} of ${messages.length} message${messages.length === 1 ? '' : 's'}`,
  );
  deps.out('');

  if (tail.length === 0) {
    deps.out('(no messages yet)');
    return 0;
  }

  for (const entry of tail) {
    const view = summarizeMessage(entry);
    if (!view) continue;
    const who = view.agent ? `${view.role} (${view.agent})` : view.role;
    deps.out(`[${who}]${view.finish ? ` finish=${view.finish}` : ''}`);
    for (const tool of view.tools) {
      deps.out(`  · ${tool.name} — ${tool.status}`);
    }
    for (const text of view.text) {
      for (const line of text.split('\n')) deps.out(`  ${line}`);
    }
    if (view.error) deps.out(`  !! ${view.error}`);
    deps.out('');
  }

  return 0;
}

// ── liveness ──────────────────────────────────────────────────────────

/**
 * Read one session's liveness out of `GET /session/status`.
 *
 * The endpoint returns only ACTIVE sessions, so an absent key means idle —
 * which is exactly the post-abort state we are waiting for.
 */
export function statusOf(data: unknown, sessionID: string): LaneLiveness {
  // Deliberately NOT the plugin's `runtimeSessionStatus`, which this must not
  // import: that module belongs to the hook runtime and its safe default is
  // the opposite one. It maps an unrecognised entry to `busy` so the watchdog
  // never stalls a lane it merely failed to parse; here every caller ACTS on
  // the answer — abort, prompt — so an unrecognised shape must be `unknown`
  // and fail CLOSED. Same endpoint, opposite safe default.
  if (typeof data !== 'object' || data === null) return 'unknown';
  const entry = (data as Record<string, unknown>)[sessionID];
  if (entry === undefined) return 'idle';
  if (typeof entry !== 'object' || entry === null) return 'unknown';
  const type = (entry as { type?: unknown }).type;
  if (type === 'idle') return 'idle';
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'unknown';
}

/**
 * One `session.status` read for the WHOLE server.
 *
 * `undefined` (transport fault, HTTP error) makes every lookup `unknown`,
 * which every caller treats as "do not touch".
 */
async function readStatusMap(
  client: LaneClient,
  directory: string,
): Promise<unknown> {
  try {
    const statuses = await client.session.status({
      query: { directory },
    });
    return statuses?.error ? undefined : statuses?.data;
  } catch {
    return undefined;
  }
}

/** One `session.status` read, collapsed to this lane's liveness. */
async function readLaneStatus(
  client: LaneClient,
  sessionID: string,
  directory: string,
): Promise<LaneLiveness> {
  return statusOf(await readStatusMap(client, directory), sessionID);
}

// ── stop ──────────────────────────────────────────────────────────────

/**
 * States whose session is retained, idle, and revivable in place.
 *
 * `stopped` is the plugin's "the runtime says this child no longer executes
 * but no task result explained why"; `error` is what an abort (and a dead
 * transport) lands as. Both keep the session — `task_revive` resumes them —
 * so a `stop` on one of these is a no-op that still deserves a record.
 * `cancelled` is excluded on purpose: that outcome was produced by the
 * orchestrator's own `task_cancel` and is already attributed.
 */
function isRetainedStopped(lane: LaneMirrorRecord): boolean {
  return lane.state === 'stopped' || lane.state === 'error';
}

/**
 * `stop` on a lane that is already dead: record the cancel, abort nothing.
 *
 * Exit code 0 because the user's intent — "this lane stays stopped" — is
 * satisfied; only the mechanism differs from the live case. The recorded
 * intent is what a future auto-revive must consult before restarting a lane
 * the user deliberately ended.
 */
function reportAlreadyStopped(input: {
  lane: LaneMirrorRecord;
  sessionID: string;
  serverUrl: string;
  status: LaneLiveness;
  reason?: string;
  json: boolean;
  directory: string;
  deps: LanesDeps;
}): number {
  const { lane, sessionID, serverUrl, status, reason, json, directory, deps } =
    input;
  const now = deps.now ?? (() => Date.now());
  const intentsFile = deps.intentsFile ?? laneIntentsPath(directory);
  const recorded = appendLaneIntent(intentsFile, {
    at: now(),
    action: 'stop',
    sessionID,
    reason,
  });

  if (json) {
    deps.out(
      JSON.stringify(
        {
          action: 'stop',
          sessionID,
          alias: lane.alias,
          agent: lane.agent,
          serverUrl,
          aborted: false,
          alreadyStopped: true,
          verified: true,
          status,
          state: lane.state,
          intentRecorded: recorded,
          reason,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  deps.out(
    `${lane.alias} (${lane.agent}) was already stopped (state: ${lane.state}).`,
  );
  if (recorded) {
    deps.out('Recorded as your cancellation; nothing was aborted.');
  } else {
    deps.out('Note: the cancellation could not be recorded.');
  }
  deps.out(
    'Its session survives, so the orchestrator can resume it in place with',
  );
  deps.out('task_revive if you change your mind.');
  return 0;
}

export async function runLanesStop(
  args: LanesTargetOptions & { reason?: string },
  deps: LanesDeps,
): Promise<number> {
  const { directory, selector, serverFlag, json, reason, force } = args;
  const resolved = await resolveTarget(directory, selector, serverFlag, deps, {
    force,
    mutating: true,
  });
  if (typeof resolved === 'number') return resolved;
  const { lane, sessionID, client, serverUrl } = resolved;
  const now = deps.now ?? (() => Date.now());

  // S2: confirm the lane is actually active on THIS server before doing
  // anything. Without it, aborting a lane that lives on another server (or
  // that finished minutes ago) still returns 200 and we would print a
  // confident "Stopped" for a no-op — and leave a stop intent behind that
  // could later mislabel an unrelated abort of the same id.
  const before = await readLaneStatus(client, sessionID, directory);
  const active = before === 'busy' || before === 'retry';

  // "Stop it, I mean it": the lane is already dead, so there is nothing to
  // abort, but the cancel still has to be recorded.
  //
  // Requires the server to POSITIVELY report idle — not merely "not active".
  // `unknown` means we could not reach the server, or reached the wrong one,
  // in which case the lane may well still be running somewhere and printing
  // "already stopped" would be a lie. Those fall through to the refusal below,
  // which says exactly that. A stale mirror therefore cannot turn a genuine
  // "stop this running lane" into a no-op either.
  if (lane && isRetainedStopped(lane) && before === 'idle') {
    return reportAlreadyStopped({
      lane,
      sessionID,
      serverUrl,
      status: before,
      reason,
      json,
      directory,
      deps,
    });
  }

  if (!force && !active) {
    if (json) {
      deps.out(
        JSON.stringify(
          {
            action: 'stop',
            sessionID,
            alias: lane?.alias,
            serverUrl,
            aborted: false,
            verified: false,
            status: before,
            reason,
            error: 'lane is not active',
          },
          null,
          2,
        ),
      );
      return 1;
    }
    deps.err(
      `Lane ${lane?.alias ?? sessionID} is not active on ${serverUrl} (status: ${before}).`,
    );
    deps.err(
      before === 'idle'
        ? 'There is nothing to stop: it already finished, or it belongs to a different server.'
        : 'Its status could not be read, so aborting could hit the wrong server.',
    );
    deps.err(
      'Check "omos lanes list" / "omos lanes show", pass --server, or use --force.',
    );
    return 1;
  }

  // Write the intent FIRST. The plugin sees the resulting
  // session.error(MessageAbortedError) within milliseconds and has no other
  // way to tell a user cancel from any other abort; a line written after the
  // abort would lose that race and the kill would be reported anonymously.
  const intentsFile = deps.intentsFile ?? laneIntentsPath(directory);
  const recorded = appendLaneIntent(intentsFile, {
    at: now(),
    action: 'stop',
    sessionID,
    reason,
  });

  let response: LaneSdkResponse;
  try {
    response = await client.session.abort({
      path: { id: sessionID },
      query: { directory },
    });
  } catch (error) {
    return reportUnreachable(deps, serverUrl, error);
  }
  if (response?.error) {
    if (response.response?.status === 404) {
      deps.err(`Session ${sessionID} does not exist on ${serverUrl}.`);
      return 1;
    }
    return reportUnreachable(deps, serverUrl, response.error);
  }

  // Verify rather than assume: `abort` returning 200 only means the request
  // was accepted. Polling proves the lane actually stopped, which is the one
  // thing the user cares about.
  const verifyMs = deps.abortVerifyMs ?? DEFAULT_ABORT_VERIFY_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + verifyMs;
  let observed: LaneLiveness = 'unknown';

  while (now() <= deadline) {
    observed = await readLaneStatus(client, sessionID, directory);
    if (observed === 'idle') break;
    if (now() + ABORT_POLL_INTERVAL_MS > deadline) break;
    await sleep(ABORT_POLL_INTERVAL_MS);
  }

  // S6: a forced abort of a lane this server never reported as active proves
  // nothing. The post-abort `idle` reading is exactly what an untouched idle
  // session looks like, so calling that "Stopped" would report success for a
  // request that may have gone to the wrong server entirely.
  const stopped = active && observed === 'idle';

  if (json) {
    deps.out(
      JSON.stringify(
        {
          action: 'stop',
          sessionID,
          alias: lane?.alias,
          agent: lane?.agent,
          serverUrl,
          aborted: true,
          forced: force === true,
          activeBefore: active,
          verified: stopped,
          status: observed,
          intentRecorded: recorded,
          reason,
        },
        null,
        2,
      ),
    );
    return stopped ? 0 : 1;
  }

  const label = lane ? `${lane.alias} (${lane.agent})` : sessionID;
  if (stopped) {
    deps.out(`Stopped ${label}.`);
  } else if (!active) {
    deps.err(
      `Abort sent to ${serverUrl} for ${label}, but this server did not report the lane`,
    );
    deps.err(
      `as active (status before: ${before}, after: ${observed}), so nothing may have`,
    );
    deps.err('happened.');
    deps.err(
      'If the lane is real, it is running on another server: find its URL and',
    );
    deps.err('re-run with --server.');
  } else {
    deps.err(
      `Abort accepted for ${label}, but the session is still "${observed}" after ${Math.round(
        verifyMs / 1000,
      )}s.`,
    );
    deps.err('Re-run to abort again, or check the server logs.');
  }
  deps.out('The session itself survives and stays resumable (task_revive).');
  if (recorded) {
    deps.out(
      'The orchestrator will see this as your cancellation on its next turn',
    );
    deps.out('(no extra prompt, no token cost).');
  } else {
    deps.out(
      'Note: the cancellation reason could not be recorded, so the orchestrator',
    );
    deps.out('will report this as an anonymous abort.');
  }
  return stopped ? 0 : 1;
}

// ── say ───────────────────────────────────────────────────────────────

/**
 * States in which an injected message can still do something useful.
 *
 * `running` is the intended case (probe A1: the lane picks the text up after
 * its current step and it becomes part of the result the orchestrator reads),
 * including a `running` record flagged `statusUncertain` — that flag means the
 * plugin distrusts its own reading, not that the lane is gone, and prompting
 * it is one of the few ways to find out.
 *
 * `stopped`/`error` keep their session, so a message WOULD land somewhere
 * real, but nothing is running to act on it and no result will reach the
 * orchestrator; those need `--force` and a clear warning. Everything else has
 * already produced its result.
 */
/**
 * Establish the model to pin on an injected message.
 *
 * Two sources, most authoritative first, mirroring `task_message`:
 *   1. `session.get().model` (+ `variant`) — the session's CURRENT model, i.e.
 *      whatever foreground fallback last moved it to.
 *   2. the newest USER message's `info.model` — the last model something
 *      actually prompted this session with, for hosts whose session record
 *      omits it.
 *
 * `undefined` means "could not establish", which is a refusal (see the MODEL
 * rule in the file header), not a licence to omit the field.
 */
async function resolveLaneModel(
  client: LaneClient,
  sessionID: string,
  directory: string,
): Promise<ContinuationModelSelection | undefined> {
  try {
    const response = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
    if (!response?.error && isRecord(response?.data)) {
      const selection = parseContinuationModelSelection(
        response.data.model,
        response.data.variant,
      );
      if (selection) return selection;
    }
  } catch {
    // Fall through to the message log; an unreachable server is reported by
    // the prompt call itself, not by this lookup.
  }

  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    if (response?.error || !Array.isArray(response?.data)) return undefined;
    for (let index = response.data.length - 1; index >= 0; index -= 1) {
      const entry = response.data[index];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sayabilityOf(
  lane: LaneMirrorRecord,
): { ok: true } | { ok: false; why: string; retained: boolean } {
  if (lane.state === 'running') return { ok: true };
  if (isRetainedStopped(lane)) {
    return {
      ok: false,
      retained: true,
      why: lane.cancelledByUser
        ? 'you stopped this lane'
        : `this lane is ${lane.state}`,
    };
  }
  return {
    ok: false,
    retained: false,
    why: `this lane already finished (${lane.state})`,
  };
}

export async function runLanesSay(
  args: LanesTargetOptions & { text: string },
  deps: LanesDeps,
): Promise<number> {
  const { directory, selector, serverFlag, json, text, force } = args;
  const resolved = await resolveTarget(directory, selector, serverFlag, deps, {
    force,
    mutating: true,
  });
  if (typeof resolved === 'number') return resolved;
  const { lane, sessionID, client, serverUrl } = resolved;

  // The orchestrator's own cancellation path owns this run: `task_cancel` (or
  // `task_revive`'s cancel-then-relaunch) holds a cancellation lease and is
  // mid-abort. `task_message` refuses outright in this state and so does this
  // command — not overridable while the lane is still running, because a
  // prompt racing an in-flight abort is the one case where the two writers are
  // guaranteed to disagree. Once the run is terminal the flag is merely
  // history, and the normal `--force` path below applies.
  if (lane?.cancellationRequested && lane.state === 'running') {
    deps.err(
      `Refusing to message ${lane.alias}: the orchestrator is cancelling it right now.`,
    );
    deps.err(
      'Its cancellation lease owns the session, so a prompt would race the',
    );
    deps.err(
      'abort. Wait for the lane to settle ("omos lanes list"), then decide.',
    );
    return 1;
  }

  // S3: a message into a settled lane is almost always a mistake — it either
  // goes nowhere useful or starts a turn whose reply nobody will read. Refuse
  // by default, and be specific about what would happen.
  if (lane && !force) {
    const sayable = sayabilityOf(lane);
    if (!sayable.ok) {
      deps.err(
        `Refusing to message ${lane.alias}: ${sayable.why} (state: ${lane.state}).`,
      );
      if (sayable.retained) {
        deps.err(
          'Its session still exists, so a message WOULD start a turn — but the',
        );
        deps.err(
          'reply will not reach the orchestrator; ask it to run task_revive',
        );
        deps.err(`(task_id: "${lane.alias}") if this lane should continue.`);
        deps.err('Use --force to message it anyway.');
      } else {
        deps.err('Use --force if you really mean to prompt it.');
      }
      return 1;
    }
  }

  // A2: no agent, no message. Prompting a child session without its own agent
  // rewrites session.agent to `build` the instant the server accepts the
  // request — permanently converting a specialist lane into a generic build
  // session. There is no safe guess available here, so refuse and say why.
  // NOTE: deliberately NOT overridable by --force; this is a correctness rule,
  // not a safety rail, and there is no valid value to fall back to.
  const agent = lane?.agent?.trim();
  if (!agent) {
    deps.err(
      lane
        ? `Lane ${lane.alias} has no recorded agent, so its message cannot be sent safely.`
        : `No lane record for "${selector}", so its agent is unknown.`,
    );
    deps.err(
      "Sending a prompt without the session's own agent would permanently",
    );
    deps.err(
      'rewrite that session to the default "build" agent (probe A2), so this',
    );
    deps.err('command refuses to guess.');
    deps.err(
      'Use "omos lanes list" to find a lane with a known agent, or ask the',
    );
    deps.err('orchestrator to message it (task_message).');
    return 1;
  }

  // Cross-server check. NOT the same concern as the state gate above (which
  // asks "is this lane worth messaging?"); this asks "is the lane running on
  // the server I am about to talk to?".
  //
  // Two servers can share one directory (a TUI plus an `opencode serve`), and
  // the sidecar is last-writer-wins, so a `running` lane's message can be
  // delivered to the server that is NOT running it. That server shares the
  // message store but has no in-flight turn for the session, so it sees an
  // IDLE session and starts a CONCURRENT turn on a session the other process
  // is mid-turn in — two writers on one message log. That is a corruption
  // class of bug, not a usability one, so a lane the mirror calls `running`
  // must actually be busy HERE.
  //
  // A `running` record the plugin has flagged `statusUncertain` is exempt from
  // the refusal: an idle reading is exactly what that flag is about (a hung
  // stream, or a stop inside its confirmation grace), so it warns instead.
  if (lane && !force) {
    const live = await readLaneStatus(client, sessionID, directory);
    const activeHere = live === 'busy' || live === 'retry';
    if (!activeHere && lane.state === 'running' && !lane.statusUncertain) {
      deps.err(
        `Lane ${lane.alias} is not active on ${serverUrl} (status: ${live}) — already finished, or belongs to a different server?`,
      );
      deps.err(
        'Messaging it here could start a second, concurrent turn on a session',
      );
      deps.err(
        'another server is mid-turn in. Check "omos lanes show", pass --server,',
      );
      deps.err('or use --force.');
      return 1;
    }
    if (!activeHere && lane.state === 'running') {
      deps.err(
        `Warning: ${lane.alias} is flagged status-uncertain and not active on ${serverUrl} (status: ${live}).`,
      );
      deps.err(
        'Sending anyway (that is what the flag means), but if this lane lives',
      );
      deps.err('on another server, pass --server to reach it there.');
    }
  }

  // MODEL rule (see the file header): resolve the lane's live model and pin
  // it, or refuse. Omitting the field does not mean "keep the current model";
  // it means core falls back to the AGENT's configured model, which undoes a
  // foreground-fallback failover behind the user's back.
  const pinned = await resolveLaneModel(client, sessionID, directory);
  if (!pinned && !force) {
    deps.err(
      `Refusing to message ${lane?.alias ?? sessionID}: its current model could not be established.`,
    );
    deps.err(
      'A prompt without an explicit model is resolved against the agent\u2019s',
    );
    deps.err(
      'CONFIGURED model, which would silently move this lane back onto it —',
    );
    deps.err(
      'undoing any fallback that had switched it away. `task_message` refuses',
    );
    deps.err('for the same reason.');
    deps.err(
      'Check the server is reachable ("omos lanes show"), or use --force to',
    );
    deps.err('send without a model pin.');
    return 1;
  }
  if (!pinned) {
    deps.err(
      `Forcing: ${lane?.alias ?? sessionID}'s model could not be pinned, so this prompt may`,
    );
    deps.err("re-pin the lane to its agent's configured model.");
  }

  // A note into a lane that is not running must not START one. `noReply` makes
  // the text land in the transcript without a turn, so the next `task_revive`
  // (or a resume by the orchestrator) reads it as context instead of the user
  // getting an answer nobody will ever see. Running lanes keep the probe-A1
  // behaviour: queued, picked up after the current step.
  const quiet = lane !== undefined && lane.state !== 'running';

  // No intent line is written here. Only `stop` needs one (to label the abort
  // it is about to cause); a `say` intent would have no reader, and an unread
  // copy of the user's prompt text on disk is a liability, not an audit trail.
  //
  // `promptAsync` (not the blocking `prompt` that `task_message` uses) because
  // probe A1 measured exactly this call against a running child: HTTP 204
  // immediately, queued, processed after the current step, session agent and
  // model unchanged.
  let response: LaneSdkResponse;
  try {
    response = await client.session.promptAsync({
      path: { id: sessionID },
      query: { directory },
      body: withAgent(
        {
          ...(pinned
            ? {
                model: pinned.model,
                ...(pinned.variant ? { variant: pinned.variant } : {}),
              }
            : {}),
          ...(quiet ? { noReply: true } : {}),
          parts: [{ type: 'text', text }],
        },
        agent,
      ),
    });
  } catch (error) {
    return reportUnreachable(deps, serverUrl, error);
  }
  if (response?.error) {
    if (response.response?.status === 404) {
      deps.err(`Session ${sessionID} does not exist on ${serverUrl}.`);
      return 1;
    }
    return reportUnreachable(deps, serverUrl, response.error);
  }

  if (json) {
    deps.out(
      JSON.stringify(
        {
          action: 'say',
          sessionID,
          alias: lane?.alias,
          agent,
          model: pinned?.model,
          variant: pinned?.variant,
          modelPinned: pinned !== undefined,
          noReply: quiet,
          serverUrl,
          queued: true,
          text,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const target = lane ? `${lane.alias} (${agent})` : sessionID;
  if (quiet) {
    deps.out(`Noted in ${target}'s transcript:`);
    deps.out(`  ${truncate(text, 200)}`);
    deps.out('');
    deps.out(
      'The lane is not running, so nothing was started: the text is queued in',
    );
    deps.out(
      'the session as a note. Whoever resumes it next — task_revive, or the',
    );
    deps.out('orchestrator picking the lane back up — reads it as context.');
    return 0;
  }

  deps.out(`Queued for ${target}:`);
  deps.out(`  ${truncate(text, 200)}`);
  deps.out('');
  deps.out(
    'The lane picks this up after its current step finishes, not immediately.',
  );
  deps.out(
    'Its reply becomes part of the result the orchestrator eventually reads,',
  );
  deps.out('so treat this as course-correction, not a private side channel.');
  return 0;
}
