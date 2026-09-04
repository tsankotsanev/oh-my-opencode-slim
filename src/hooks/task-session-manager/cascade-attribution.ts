/**
 * An abort of the orchestrator: attributing the deaths, and optionally undoing
 * them.
 *
 * ## The problem
 *
 * `session.abort` on a parent kills the **whole session tree**, from a busy
 * parent *and* from an idle one (`docs/agents/subagent-probe-results.md`,
 * probes B1/B3). The plugin cannot prevent that — it observes events, it does
 * not own the abort — so an abort of the orchestrator always takes every
 * background lane with it. Each of those deaths already lands as an `error`
 * record whose session is intact and revivable in place. What is missing is
 * the *cause*: an abort event carries none, so "the user pressed ESC" and
 * "something aborted this one lane" arrive as byte-identical events.
 *
 * Two things abort an orchestrator, and only one of them is a person:
 *
 * - **ESC** in the TUI ({@link CascadeCause} `'esc'`);
 * - **the plugin's own foreground fallback** (`'fallback'`), which aborts the
 *   orchestrator and re-prompts it on a fallback model to recover from a
 *   rate-limit or auth failure. The parent survives; every lane it owned does
 *   not. Nobody asked for that, which is why the cause travels on the stamp
 *   instead of the wording assuming a keypress.
 *
 * Without the attribution the board shows N independent anonymous failures,
 * and the orchestrator's cheapest-looking next move is to relaunch N tasks
 * from scratch — when every session is intact and resumable for free.
 *
 * ## Detecting it
 *
 * The ordering is the hard part. Probe B1 shows the CHILD is aborted first and
 * the parent ~0.1s later, so a purely forward-looking window opened by the
 * parent's own abort would always be too late. Detection is therefore
 * two-sided:
 *
 * - a child abort with no `stop` intent and no orchestrator-owned cancel
 *   behind it becomes a **candidate**;
 * - a subsequent orchestrator abort **confirms** every candidate recorded in
 *   the last {@link CASCADE_WINDOW_MS} and opens a forward window, so children
 *   whose events arrive after the parent's are tagged too. This is also the
 *   only path that can observe a cause: a `'fallback'` abort always produces
 *   the parent's own `session.error`, so the idle rules below are `'esc'` by
 *   construction.
 *
 * The idle-parent case (B3) has no parent `session.error` at all — the parent
 * only emits `session.status{idle}` + `session.idle`, and it emits that idle
 * even though it was ALREADY idle. That redundant idle is the whole signal, so
 * a parent idle also confirms — but the rule depends on what the parent was
 * doing when its child died, which the tracker follows from the same status
 * events:
 *
 * | parent at candidate time | confirming idle | rule |
 * |--------------------------|-----------------|------|
 * | idle (B3 topology: parent done, lane still working) | redundant, cannot happen for any other reason | ONE candidate is enough |
 * | busy (B1/B2 topology) | a natural end-of-turn idle | needs TWO or more sibling candidates |
 * | never observed | — | treated as busy (fail closed) |
 *
 * The busy row is why the threshold exists at all: probe B2 shows a parent
 * going idle ~0.7s after an unrelated single-child abort simply because it
 * finished its own turn. Two sibling lanes aborted anonymously within three
 * seconds have no such innocent explanation.
 *
 * Everything else stays untagged, which is the conservative outcome: an
 * untagged lane is still `error`, still says its session is intact, and is
 * still revivable by name or with `--all`. It is merely not eligible for
 * `--cascade`, and never for auto-revive.
 *
 * Known residual ambiguity: two per-pane ESCs on sibling lanes within three
 * seconds, while their parent happens to finish its turn, produce the same
 * evidence as one ESC on the parent. The consequence is a wrong label in
 * `'off'` mode and an unwanted restart in `'auto'` — recoverable with `omos
 * lanes stop`, and documented in docs/background-orchestration.md.
 *
 * Nested lanes (a lane that itself launched lanes) are only attributed through
 * the parent-abort path: their parent is not a managed orchestrator, so no
 * liveness is tracked for it and the idle rules never fire. Untagged is the
 * safe outcome.
 *
 * ## Undoing it
 *
 * `backgroundJobs.reviveOnCascade: 'auto'` resumes the tagged lanes after the
 * window closes plus {@link AUTO_REVIVE_DELAY_MS}, through the same
 * `task_revive` machinery the orchestrator uses (`revive-run.ts`), so the
 * parent still gets its synthesized `<task>` notification when the resumed run
 * ends. Three gestures keep that mode survivable, and the honest list is
 * shorter than it looks:
 *
 * - **the delay itself**, so `omos lanes stop` can still land first — and
 *   because the lanes are already dead and idle by then, `stop` records the
 *   cancel instead of aborting, which this module CLAIMS immediately before
 *   prompting. This is the gesture that always works.
 * - **a per-lane {@link AUTO_REVIVE_COOLDOWN_MS} cooldown**, which closes the
 *   kill → revive → kill → revive loop that cancelling timers alone cannot: a
 *   re-killed lane belongs to a NEW cascade with a new ledger, so only a
 *   board-backed stamp can rate-limit it.
 * - **one live status read** immediately before prompting, so a lane that is
 *   busy (already revived by hand, or running on another server) is never
 *   touched.
 *
 * A second orchestrator abort cancels the pending revives of earlier cascades
 * ({@link cancelSupersededAutoRevives}) — but ONLY when that abort is
 * observable, and after the first cascade it usually is not. The first abort
 * leaves the parent idle, and aborting an idle session emits no
 * `session.error` at all (probe B3): the host sends only `session.status{idle}`
 * + `session.idle`, and with every lane already dead there are no candidates,
 * so `noteOrchestratorIdle` returns before it can confirm or cancel anything.
 * So "press ESC twice" is a real gesture only while the orchestrator is still
 * busy. When it is idle, the working gesture is `omos lanes stop` inside the
 * delay.
 *
 * None of these is as unambiguous as simply not restarting anything, which is
 * why the default is `off` and the config marks `auto` EXPERIMENTAL.
 */

import type {
  BackgroundJobRecord,
  CascadeCause,
  CascadeStamp,
} from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import { canonicalDirectory } from '../../utils/lane-mirror';
import { isReviveableRetainedJob } from '../../utils/lane-state';
import { log } from '../../utils/logger';
import type { RuntimeSessionStatusSnapshot } from '../../utils/session-runtime-status';

/**
 * How long a cascade "belongs together".
 *
 * Probes B1/B3 put the whole tree-abort inside ~0.2s. Three seconds is two
 * orders of magnitude of slack for a loaded host while staying far below any
 * plausible gap between two unrelated deliberate aborts.
 */
export const CASCADE_WINDOW_MS = 3_000;

/**
 * Grace period after the window closes before `auto` mode resumes anything.
 *
 * ESC must not stop being a panic button: whoever wanted everything dead gets
 * this long to run `omos lanes stop` (or Ctrl-C the server) before lanes start
 * moving again.
 */
export const AUTO_REVIVE_DELAY_MS = 10_000;

/**
 * Minimum gap between two AUTOMATIC restarts of the same lane.
 *
 * Ten minutes is long enough that a user hammering ESC always wins, and short
 * enough that a genuine second interruption an hour into a long task is still
 * recovered automatically.
 *
 * Internal on purpose: a user who wants a different policy has
 * `reviveOnCascade: 'off'` plus `omos lanes revive`, which is never rate
 * limited.
 */
export const AUTO_REVIVE_COOLDOWN_MS = 10 * 60_000;

export type ReviveOnCascadeMode = 'off' | 'auto';

/** Bound on the "already auto-revived" ledger; see `markAttempted`. */
const MAX_ATTEMPT_KEYS = 256;

export interface CascadeTrackerOptions {
  backgroundJobBoard: BackgroundJobStore;
  /** `'off'` (default) never prompts anything; detection still runs. */
  mode?: ReviveOnCascadeMode;
  /** One `GET /session/status` snapshot for the whole server. */
  fetchSessionStatuses?: () => Promise<
    RuntimeSessionStatusSnapshot | undefined
  >;
  /**
   * Resume one lane through the shared `task_revive` machinery.
   *
   * The implementation MUST pin the lane's own agent and model
   * (`resumeRetainedLane`): an agent-less prompt permanently rewrites the
   * session to `build` (probe A2), and a model-less one undoes a fallback.
   */
  reviveLane?: (record: BackgroundJobRecord) => Promise<void>;
  /**
   * Claim a `stop` intent for this lane written no earlier than `sinceMs` ago.
   *
   * The panic gesture for `'auto'` mode. After a cascade the lane is already
   * terminal and idle, so `omos lanes stop` performs no abort and no
   * `session.error` will ever arrive to trigger the usual intent claim — the
   * mirror-flush sweep and this call are the only readers of that line.
   * Consulted once per lane, immediately before prompting.
   */
  claimStopIntent?: (
    sessionID: string,
    sinceMs: number,
  ) => { reason?: string } | undefined;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Test seams. */
  windowMs?: number;
  autoReviveDelayMs?: number;
  autoReviveCooldownMs?: number;
}

export interface CascadeTracker {
  /**
   * An anonymous child abort (no stop intent, no orchestrator-owned cancel).
   * Tags the lane when a cascade is already confirmed, otherwise remembers it
   * as a candidate.
   */
  noteChildAbort(taskID: string, parentSessionID: string): void;
  /**
   * The orchestrator itself was aborted (probe B1) — confirms a cascade.
   *
   * `cause` is the caller's reading of WHY: `'fallback'` when the plugin's own
   * foreground fallback has an abort in flight for this session, `'esc'`
   * otherwise. A second call outside the first window is a second abort, which
   * CANCELS any auto-revive still pending for that parent.
   */
  noteOrchestratorAbort(parentSessionID: string, cause: CascadeCause): void;
  /** A managed orchestrator started a turn. Feeds the B3/B2 discriminator. */
  noteOrchestratorBusy(parentSessionID: string): void;
  /**
   * A managed orchestrator went idle. Confirms a cascade for a parent with two
   * or more pending candidates, or with one candidate whose parent was already
   * idle when it died (the B3 signature).
   */
  noteOrchestratorIdle(parentSessionID: string): void;
  /** Test/shutdown seam: run any scheduled auto-revive immediately. */
  flushAutoRevive(): Promise<void>;
  dispose(): void;
}

interface Candidate {
  taskID: string;
  at: number;
  /**
   * Whether the parent was already idle when this lane died.
   *
   * Captured at candidate time, not read later: by the time a cascade is
   * confirmed the parent is idle in every case, so the distinction only exists
   * in this snapshot.
   */
  parentWasIdle: boolean;
}

/** What made us look at a parent; decides how much evidence is enough. */
type ConfirmTrigger =
  | 'parent-abort'
  /** A real `session.idle` for the parent, arriving after the candidate. */
  | 'parent-idle'
  /**
   * A new candidate arriving after a still-fresh parent idle. Never enough on
   * its own: "parent idled, then a lane died 2s later" is the reverse of the
   * B3 ordering and is not a cascade at all.
   */
  | 'late-candidate';

interface ParentLiveness {
  busy: boolean;
  lastIdleAt: number;
}

export function createCascadeTracker(
  options: CascadeTrackerOptions,
): CascadeTracker {
  const board = options.backgroundJobBoard;
  const mode = options.mode ?? 'off';
  const now = options.now ?? (() => Date.now());
  const startTimer = options.setTimeoutFn ?? setTimeout;
  const stopTimer = options.clearTimeoutFn ?? clearTimeout;
  const windowMs = options.windowMs ?? CASCADE_WINDOW_MS;
  const autoReviveDelayMs = options.autoReviveDelayMs ?? AUTO_REVIVE_DELAY_MS;
  const cooldownMs = options.autoReviveCooldownMs ?? AUTO_REVIVE_COOLDOWN_MS;

  /** Anonymous child aborts awaiting confirmation, per parent. */
  const candidates = new Map<string, Candidate[]>();
  /** Confirmed cascades: parent → the shared stamp every member gets. */
  const windows = new Map<string, { at: number; cause: CascadeCause }>();
  /**
   * Busy/idle history of MANAGED orchestrators only.
   *
   * Bounded by construction: the event router feeds this exclusively for
   * sessions `shouldManageSession` accepts, so it holds one entry per
   * orchestrator in the process, not one per session.
   */
  const parents = new Map<string, ParentLiveness>();
  /**
   * Scheduled auto-revives, keyed by `${parent}@${cascadeAt}`.
   *
   * Keyed by the cascade and not just the parent so a second ESC cannot cancel
   * the first cascade's pending revive by replacing its timer.
   */
  const scheduled = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      parentSessionID: string;
      at: number;
    }
  >();
  /** `${taskID}@${at}` for every lane auto-revive has already touched. */
  const attempted = new Set<string>();
  const attemptOrder: string[] = [];
  let disposed = false;

  /**
   * At most once per lane per cascade — recorded BEFORE the prompt is sent, so
   * a rejected prompt is not retried by a later sweep either.
   */
  function markAttempted(key: string): void {
    attempted.add(key);
    attemptOrder.push(key);
    while (attemptOrder.length > MAX_ATTEMPT_KEYS) {
      const evicted = attemptOrder.shift();
      if (evicted !== undefined) attempted.delete(evicted);
    }
  }

  /** Drop windows and candidates that can no longer match anything. */
  function sweep(at: number): void {
    for (const [parent, open] of windows) {
      if (at - open.at > windowMs) windows.delete(parent);
    }
    for (const [parent, pending] of candidates) {
      const fresh = pending.filter((entry) => at - entry.at <= windowMs);
      if (fresh.length === 0) candidates.delete(parent);
      else if (fresh.length !== pending.length) candidates.set(parent, fresh);
    }
  }

  /**
   * Fail closed on an unobserved parent: "unknown" is treated as BUSY, which
   * only ever demands MORE evidence (the two-sibling rule).
   */
  function parentIsIdle(parentSessionID: string): boolean {
    return parents.get(parentSessionID)?.busy === false;
  }

  /** Is the evidence for `parentSessionID` sufficient under `trigger`? */
  function shouldConfirm(
    trigger: ConfirmTrigger,
    pending: Candidate[],
  ): boolean {
    if (trigger === 'parent-abort') return true;
    if (pending.length >= 2) return true;
    // The B3 shape: a lane died while its parent was already idle, and the
    // parent then emitted an idle it had no other reason to emit.
    return (
      trigger === 'parent-idle' &&
      pending.some((candidate) => candidate.parentWasIdle)
    );
  }

  function tag(taskID: string, stamp: CascadeStamp): void {
    const updated = board.markCascade(taskID, stamp);
    if (updated?.killedByCascade?.at !== stamp.at) return;
    log('[task-session-manager] lane attributed to an orchestrator cascade', {
      taskID,
      alias: updated.alias,
      parentSessionID: stamp.parentSessionID,
      cascadeAt: stamp.at,
      cause: stamp.cause,
    });
  }

  /**
   * Open (or extend) a cascade for `parentSessionID` and tag its candidates.
   *
   * An already-open, still-fresh window keeps its original `at` AND its
   * original cause: every lane of one cascade must share the stamp, or
   * grouping and `--cascade` selection would split one abort into two.
   *
   * `cause` is only ever supplied by the `parent-abort` trigger. The idle
   * triggers cannot observe one and pass `'esc'`, which is correct rather than
   * a default: a fallback abort is always accompanied by the parent's own
   * `session.error`, so an idle-only confirmation is a keypress by
   * construction.
   */
  function confirm(
    parentSessionID: string,
    trigger: ConfirmTrigger,
    cause: CascadeCause,
  ): void {
    if (disposed) return;
    const at = now();
    sweep(at);

    const pending = candidates.get(parentSessionID) ?? [];
    const open = windows.get(parentSessionID);
    if (open === undefined && !shouldConfirm(trigger, pending)) return;

    const stamp = open ?? { at, cause };
    windows.set(parentSessionID, stamp);
    candidates.delete(parentSessionID);
    for (const candidate of pending) {
      tag(candidate.taskID, { parentSessionID, ...stamp });
    }
    if (trigger === 'parent-abort') {
      cancelSupersededAutoRevives(parentSessionID, stamp.at);
    }
    scheduleAutoRevive(parentSessionID, stamp.at);
  }

  /**
   * A second ESC is a decision, not a repeat.
   *
   * After the first cascade every lane is already dead, so a second
   * orchestrator abort produces a cascade with ZERO candidates — which is
   * exactly what "no, stay stopped" looks like from here. Any auto-revive
   * still pending for an EARLIER cascade of this parent is cancelled.
   *
   * Scoped to a different `cascadeAt`, so a re-confirmation of the SAME
   * cascade (a parent abort arriving twice inside one window) cannot cancel
   * its own pending revive.
   */
  function cancelSupersededAutoRevives(
    parentSessionID: string,
    cascadeAt: number,
  ): void {
    for (const [key, entry] of [...scheduled.entries()]) {
      if (entry.parentSessionID !== parentSessionID) continue;
      if (entry.at === cascadeAt) continue;
      stopTimer(entry.timer);
      scheduled.delete(key);
      log('[task-session-manager] auto-revive cancelled by a second abort', {
        parentSessionID,
        cancelledCascadeAt: entry.at,
        newCascadeAt: cascadeAt,
      });
    }
  }

  function scheduleAutoRevive(parentSessionID: string, cascadeAt: number) {
    if (mode !== 'auto' || disposed) return;
    const key = `${parentSessionID}@${cascadeAt}`;
    // Re-confirmation of the same cascade must not restart the clock.
    if (scheduled.has(key)) return;

    const fireAt = cascadeAt + windowMs + autoReviveDelayMs;
    const delay = Math.max(0, fireAt - now());
    const timer = startTimer(() => {
      scheduled.delete(key);
      void runAutoRevive(parentSessionID, cascadeAt);
    }, delay);
    timer?.unref?.();
    scheduled.set(key, { timer, parentSessionID, at: cascadeAt });
  }

  /**
   * Which lanes this cascade may restart.
   *
   * Every clause is a refusal: `cancelledByUser` is the user's own decision;
   * `cancellationRequested` means the orchestrator owns this outcome; a lane
   * blocked on a permission answer may still have work in flight; and a lane
   * with no recorded agent cannot be prompted at all without rewriting its
   * session to `build` (probe A2).
   *
   * The outcome is read THROUGH `reconciled`, exactly as `omos lanes revive`
   * reads it. `reconciled` means "the orchestrator has been told", not a
   * different fate: if the parent takes any turn inside the 13s window — which
   * a user typing a new message right after the interruption makes likely —
   * every lane of the cascade flips to `reconciled` with
   * `terminalState: 'error'` and the stamp intact, and a literal `state ===
   * 'error'` test would silently find nothing to restart.
   */
  function isAutoRevivable(
    job: BackgroundJobRecord,
    cascadeAt: number,
  ): boolean {
    const interrupted =
      job.state === 'error' ||
      (job.state === 'reconciled' && job.terminalState === 'error');
    return (
      interrupted &&
      job.killedByCascade?.at === cascadeAt &&
      job.cancelledByUser === undefined &&
      !job.cancellationRequested &&
      job.awaitingPermission === undefined &&
      isReviveableRetainedJob(job) &&
      typeof job.agent === 'string' &&
      job.agent.trim().length > 0
    );
  }

  /**
   * Was this lane already restarted too recently to restart again?
   *
   * Separate from {@link isAutoRevivable} so the skip can be LOGGED with the
   * alias and the affordance: a cooled-down lane is one the user probably
   * wants to look at, not one to silently drop.
   */
  function isCoolingDown(job: BackgroundJobRecord, at: number): boolean {
    const last = job.lastAutoRevivedAt;
    return last !== undefined && at - last < cooldownMs;
  }

  /**
   * Only a positively idle session is a safe target.
   *
   * `busy`/`retry` means someone already revived it (or it never actually
   * stopped); an unreadable snapshot means we could not tell. Neither is a
   * case for prompting blind. An ABSENT entry is idle: the endpoint lists only
   * active sessions (probe evidence in `subagent-probe-results.md`).
   */
  function laneIsIdle(
    snapshot: RuntimeSessionStatusSnapshot | undefined,
    sessionID: string,
  ): boolean {
    if (!snapshot || snapshot.error) return false;
    if (snapshot.malformedSessionIDs.has(sessionID)) return false;
    const status = snapshot.statuses.get(sessionID);
    return status === undefined || status === 'idle';
  }

  async function runAutoRevive(
    parentSessionID: string,
    cascadeAt: number,
  ): Promise<void> {
    if (disposed || mode !== 'auto') return;
    const eligible = board
      .list(parentSessionID)
      .filter((job) => isAutoRevivable(job, cascadeAt))
      .filter((job) => !attempted.has(`${job.taskID}@${cascadeAt}`));

    const startedAt = now();
    const targets: BackgroundJobRecord[] = [];
    for (const job of eligible) {
      if (isCoolingDown(job, startedAt)) {
        log(
          `[task-session-manager] not auto-reviving ${job.alias} twice within ${
            cooldownMs / 60_000
          }m; use \`omos lanes revive ${job.alias}\``,
          { taskID: job.taskID, lastAutoRevivedAt: job.lastAutoRevivedAt },
        );
        continue;
      }
      targets.push(job);
    }
    // Leaves the lanes `error` with their cascade label intact, so the board
    // still tells the orchestrator (and the user) what happened.
    if (targets.length === 0) return;

    // One status read covers every lane of the cascade.
    let snapshot: RuntimeSessionStatusSnapshot | undefined;
    try {
      snapshot = await options.fetchSessionStatuses?.();
    } catch {
      snapshot = undefined;
    }
    if (disposed) return;

    for (const stale of targets) {
      // Re-read: the awaits above give a real result, a user `stop`, or a
      // manual revive time to land.
      const job = board.get(stale.taskID);
      if (!job || !isAutoRevivable(job, cascadeAt)) continue;
      if (isCoolingDown(job, now())) continue;
      const key = `${job.taskID}@${cascadeAt}`;
      if (attempted.has(key)) continue;

      if (!laneIsIdle(snapshot, job.taskID)) {
        log('[task-session-manager] auto-revive skipped: lane is not idle', {
          taskID: job.taskID,
          alias: job.alias,
          status: snapshot?.statuses.get(job.taskID) ?? 'unreadable',
        });
        continue;
      }

      // Last check, and the one that makes ESC survivable in `'auto'`: did the
      // user run `omos lanes stop` on this lane after the cascade? Claimed
      // (removed) so it labels this lane once and cannot leak onto a later,
      // unrelated abort.
      const stopSinceMs = Math.max(0, now() - cascadeAt);
      let stopped: { reason?: string } | undefined;
      try {
        stopped = options.claimStopIntent?.(job.taskID, stopSinceMs);
      } catch {
        stopped = undefined;
      }
      if (stopped) {
        markAttempted(key);
        board.markCancelledByUser(job.taskID, stopped.reason);
        log('[task-session-manager] auto-revive vetoed by a user stop', {
          taskID: job.taskID,
          alias: job.alias,
          reason: stopped.reason,
        });
        continue;
      }

      markAttempted(key);
      // Stamped BEFORE the prompt: a restart that is accepted but never
      // produces output must still count against the cooldown, or a lane that
      // fails to come back becomes the loop all over again.
      board.markAutoRevived(job.taskID, now());
      let revived = true;
      let failure: string | undefined;
      try {
        await options.reviveLane?.(job);
      } catch (error) {
        revived = false;
        failure = error instanceof Error ? error.message : String(error);
      }
      log('[task-session-manager] auto-revive after orchestrator cascade', {
        taskID: job.taskID,
        alias: job.alias,
        agent: job.agent,
        parentSessionID,
        cascadeAt,
        revived,
        ...(failure ? { error: failure } : {}),
      });
      if (disposed) return;
    }
  }

  return {
    noteChildAbort(taskID, parentSessionID): void {
      if (disposed || !parentSessionID) return;
      // An abort somebody ASKED for is not collateral. `cancel_task` (and
      // `task_revive`'s cancel-then-relaunch) set `cancellationRequested`
      // while the lane is still running, so the resulting
      // `MessageAbortedError` looks exactly like a cascade death even though
      // the orchestrator caused it deliberately.
      const job = board.get(taskID);
      if (!job || job.cancellationRequested === true) return;
      if (job.cancelledByUser !== undefined) return;
      const at = now();
      sweep(at);
      const open = windows.get(parentSessionID);
      if (open !== undefined) {
        tag(taskID, { parentSessionID, ...open });
        return;
      }
      const pending = candidates.get(parentSessionID) ?? [];
      if (pending.some((entry) => entry.taskID === taskID)) return;
      pending.push({
        taskID,
        at,
        parentWasIdle: parentIsIdle(parentSessionID),
      });
      candidates.set(parentSessionID, pending);

      // The confirming idle can arrive BETWEEN two sibling aborts, in which
      // case no further idle event will come and the second candidate has to
      // re-evaluate the evidence itself. `late-candidate` deliberately cannot
      // confirm on one candidate: a parent idle that PRECEDES the only death
      // is the reverse of the B3 ordering.
      const liveness = parents.get(parentSessionID);
      if (liveness && at - liveness.lastIdleAt <= windowMs) {
        confirm(parentSessionID, 'late-candidate', 'esc');
      }
    },

    noteOrchestratorAbort(parentSessionID, cause): void {
      if (disposed || !parentSessionID) return;
      // A parent abort is unambiguous evidence, so the window opens even with
      // no candidate yet: the children's events may still be in flight.
      confirm(parentSessionID, 'parent-abort', cause);
    },

    noteOrchestratorBusy(parentSessionID): void {
      if (disposed || !parentSessionID) return;
      const existing = parents.get(parentSessionID);
      if (existing?.busy === true) return;
      parents.set(parentSessionID, {
        busy: true,
        lastIdleAt: existing?.lastIdleAt ?? 0,
      });
    },

    noteOrchestratorIdle(parentSessionID): void {
      if (disposed || !parentSessionID) return;
      parents.set(parentSessionID, { busy: false, lastIdleAt: now() });
      // Cheapest possible guard: idle fires constantly, and only a parent with
      // pending anonymous child aborts can possibly be mid-cascade.
      if (!candidates.has(parentSessionID)) return;
      confirm(parentSessionID, 'parent-idle', 'esc');
    },

    async flushAutoRevive(): Promise<void> {
      for (const [key, entry] of [...scheduled.entries()]) {
        stopTimer(entry.timer);
        scheduled.delete(key);
        await runAutoRevive(entry.parentSessionID, entry.at);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of scheduled.values()) stopTimer(entry.timer);
      scheduled.clear();
      candidates.clear();
      windows.clear();
      parents.clear();
    },
  };
}

/**
 * The live cascade tracker per project directory.
 *
 * Its own registry rather than a passenger on `claimLaneWriters`, for one
 * reason: that one is claimed only when `backgroundJobs.laneControl` is on,
 * and this tracker runs regardless of lane control. A pending auto-revive
 * outliving the config update that turned `reviveOnCascade` OFF is exactly the
 * kind of surprise the whole `'off'`-by-default posture exists to prevent, so
 * the teardown must not depend on an unrelated feature flag.
 *
 * Module-level (not per-hook) precisely because the new generation has no
 * reference to the old one.
 */
const cascadeTrackersByDirectory = new Map<string, () => void>();

/**
 * Dispose the cascade tracker a previous plugin generation left running for
 * `directory`, and register `dispose` as the current owner.
 *
 * Never throws: a failed teardown of a dead generation must not stop the new
 * one from starting.
 */
export function claimCascadeTracker(
  directory: string,
  dispose: () => void,
): void {
  const key = canonicalDirectory(directory);
  const previous = cascadeTrackersByDirectory.get(key);
  cascadeTrackersByDirectory.set(key, dispose);
  if (!previous) return;
  try {
    previous();
  } catch (error) {
    log('[task-session-manager] previous cascade tracker teardown failed', {
      directory: key,
      error: String(error),
    });
  }
}

/** Forget the current owner for `directory` (called from its own dispose). */
export function releaseCascadeTracker(
  directory: string,
  dispose: () => void,
): void {
  const key = canonicalDirectory(directory);
  if (cascadeTrackersByDirectory.get(key) === dispose) {
    cascadeTrackersByDirectory.delete(key);
  }
}
