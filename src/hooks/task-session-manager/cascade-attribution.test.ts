/**
 * ESC attribution, checked against the measured event orderings in
 * `docs/agents/subagent-probe-results.md` (probes B1, B2, B3).
 *
 * Every timing here is a fake clock: the rules are about ORDER and evidence,
 * and a test that slept would be both slow and less precise about which
 * ordering it is asserting.
 */

import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type { RuntimeSessionStatusSnapshot } from '../../utils/session-runtime-status';
import {
  AUTO_REVIVE_COOLDOWN_MS,
  AUTO_REVIVE_DELAY_MS,
  CASCADE_WINDOW_MS,
  type CascadeTrackerOptions,
  createCascadeTracker,
} from './cascade-attribution';

const PARENT = 'parent-1';

function idleSnapshot(
  busy: string[] = [],
  error?: string,
): RuntimeSessionStatusSnapshot {
  return {
    statuses: new Map(busy.map((id) => [id, 'busy' as const])),
    malformedSessionIDs: new Set<string>(),
    ...(error ? { error } : {}),
  };
}

function harness(
  options: Partial<CascadeTrackerOptions> & { start?: number } = {},
) {
  const board = new BackgroundJobBoard();
  let clock = options.start ?? 100_000;
  const timers: Array<{ id: number; fn: () => void; delay: number }> = [];
  let nextTimerID = 1;

  const setTimeoutFn = ((fn: () => void, delay: number) => {
    const id = nextTimerID++;
    timers.push({ id, fn, delay });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as unknown as typeof clearTimeout;

  const revived: string[] = [];
  const tracker = createCascadeTracker({
    backgroundJobBoard: board,
    now: () => clock,
    setTimeoutFn,
    clearTimeoutFn,
    fetchSessionStatuses: async () => idleSnapshot(),
    reviveLane: async (record) => {
      revived.push(record.taskID);
    },
    ...options,
  });

  return {
    board,
    tracker,
    revived,
    timers,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** An aborted-but-intact lane, exactly as the event router records one. */
    abortedLane(taskID: string, agent = 'fixer') {
      board.registerLaunch({
        taskID,
        parentSessionID: PARENT,
        agent,
        description: `objective for ${taskID}`,
        background: true,
        now: clock - 1_000,
      });
      board.updateStatus({
        taskID,
        state: 'error',
        resultSummary: 'Aborted',
        now: clock,
      });
      return taskID;
    },
    cascadeAt(taskID: string): number | undefined {
      return board.get(taskID)?.killedByCascade?.at;
    },
  };
}

describe('cascade detection', () => {
  test('B1: the parent abort confirms even a single lane', () => {
    // Probe B1: the CHILD is aborted first, the parent ~0.1s later. A
    // forward-only window opened by the parent would always be too late.
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteOrchestratorBusy(PARENT);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(100);
    h.tracker.noteOrchestratorAbort(PARENT);

    expect(h.cascadeAt('child-1')).toBeDefined();
    expect(h.board.get('child-1')?.killedByCascade?.parentSessionID).toBe(
      PARENT,
    );
    // The label never touches the state.
    expect(h.board.get('child-1')?.state).toBe('error');
  });

  test('B1: children whose events arrive AFTER the parent are tagged too', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.abortedLane('child-2');
    h.tracker.noteOrchestratorAbort(PARENT);
    h.advance(200);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(200);
    h.tracker.noteChildAbort('child-2', PARENT);

    // One cascade: both lanes share the confirmation instant, which is what
    // makes `--cascade` address the group.
    expect(h.cascadeAt('child-1')).toBe(h.cascadeAt('child-2') as number);
  });

  test('B2: one anonymous child abort + a natural parent idle is NOT a cascade', () => {
    // Probe B2: aborting a single child leaves the parent alone, and the
    // parent goes idle ~0.7s later simply because it finished its own turn.
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteOrchestratorBusy(PARENT);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(700);
    h.tracker.noteOrchestratorIdle(PARENT);

    expect(h.cascadeAt('child-1')).toBeUndefined();
  });

  test('B3: one lane IS enough when the parent was already idle', () => {
    // The realistic background topology: the parent finished its turn, the
    // lane kept working, and ESC killed it. The parent emits an idle it had no
    // other reason to emit (there is no parent session.error at all).
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteOrchestratorIdle(PARENT);
    h.advance(5_000);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(100);
    h.tracker.noteOrchestratorIdle(PARENT);

    expect(h.cascadeAt('child-1')).toBeDefined();
  });

  test('an UNOBSERVED parent is treated as busy, so one lane is not enough', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(100);
    h.tracker.noteOrchestratorIdle(PARENT);

    expect(h.cascadeAt('child-1')).toBeUndefined();
  });

  test('two siblings within the window confirm on a busy parent idle', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.abortedLane('child-2');
    h.tracker.noteOrchestratorBusy(PARENT);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(100);
    h.tracker.noteChildAbort('child-2', PARENT);
    h.advance(100);
    h.tracker.noteOrchestratorIdle(PARENT);

    expect(h.cascadeAt('child-1')).toBeDefined();
    expect(h.cascadeAt('child-1')).toBe(h.cascadeAt('child-2') as number);
  });

  test('a late candidate can satisfy the two-sibling rule but never confirm alone', () => {
    // The confirming idle can arrive BETWEEN two sibling aborts, in which case
    // no further idle event will come.
    const alone = harness();
    alone.abortedLane('child-1');
    alone.tracker.noteOrchestratorBusy(PARENT);
    alone.tracker.noteOrchestratorIdle(PARENT);
    alone.advance(100);
    alone.tracker.noteChildAbort('child-1', PARENT);
    // Parent idled BEFORE the only death: the reverse of the B3 ordering.
    expect(alone.cascadeAt('child-1')).toBeUndefined();

    const pair = harness();
    pair.abortedLane('child-1');
    pair.abortedLane('child-2');
    pair.tracker.noteOrchestratorBusy(PARENT);
    pair.tracker.noteChildAbort('child-1', PARENT);
    pair.advance(50);
    pair.tracker.noteOrchestratorIdle(PARENT);
    pair.advance(50);
    pair.tracker.noteChildAbort('child-2', PARENT);

    expect(pair.cascadeAt('child-1')).toBeDefined();
    expect(pair.cascadeAt('child-1')).toBe(pair.cascadeAt('child-2') as number);
  });

  test('candidates older than the window are forgotten', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteOrchestratorIdle(PARENT);
    h.advance(1_000);
    h.tracker.noteChildAbort('child-1', PARENT);
    h.advance(CASCADE_WINDOW_MS + 1);
    h.tracker.noteOrchestratorAbort(PARENT);

    expect(h.cascadeAt('child-1')).toBeUndefined();
  });

  test('an orchestrator-owned cancel is never a cascade candidate', () => {
    // `cancel_task` (and `task_revive`'s cancel-then-relaunch) marks the
    // outcome cancelled, which is what tells this apart from an ESC: the
    // MessageAbortedError itself is byte-identical.
    const h = harness();
    h.abortedLane('child-1');
    h.board.markCancelled('child-1', 'superseded', h.now(), { force: true });
    h.tracker.noteChildAbort('child-1', PARENT);
    h.tracker.noteOrchestratorAbort(PARENT);

    expect(h.cascadeAt('child-1')).toBeUndefined();
  });

  test('a cancel that lands AFTER its abort event drops the provisional stamp', () => {
    // The racy ordering: `cancel_task` aborts, the child's session.error is
    // observed and (with a sibling) provisionally attributed, and only then
    // does the tool finish marking the outcome. The deliberate cancellation is
    // the truth, so the attribution must not survive it.
    const h = harness();
    h.abortedLane('child-1');
    h.abortedLane('child-2');
    h.tracker.noteChildAbort('child-1', PARENT);
    h.tracker.noteChildAbort('child-2', PARENT);
    h.tracker.noteOrchestratorAbort(PARENT);
    expect(h.cascadeAt('child-1')).toBeDefined();

    h.board.markCancelled('child-1', 'superseded', h.now(), { force: true });
    expect(h.cascadeAt('child-1')).toBeUndefined();
    expect(h.cascadeAt('child-2')).toBeDefined();
  });

  test('a lane the user stopped is never attributed to a cascade', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.board.markCancelledByUser('child-1', 'wrong file set');
    h.tracker.noteChildAbort('child-1', PARENT);
    h.tracker.noteOrchestratorAbort(PARENT);

    expect(h.cascadeAt('child-1')).toBeUndefined();
  });

  test('a cascade stamp is idempotent and keeps the original instant', () => {
    const h = harness();
    h.abortedLane('child-1');
    h.tracker.noteChildAbort('child-1', PARENT);
    h.tracker.noteOrchestratorAbort(PARENT);
    const first = h.cascadeAt('child-1');
    h.advance(10_000);
    h.tracker.noteOrchestratorAbort(PARENT);
    h.tracker.noteChildAbort('child-1', PARENT);

    expect(h.cascadeAt('child-1')).toBe(first as number);
  });
});

describe('auto-revive (reviveOnCascade: auto)', () => {
  function autoHarness(
    options: Partial<CascadeTrackerOptions> & { start?: number } = {},
  ) {
    return harness({ mode: 'auto', ...options });
  }

  /** One ESC on a busy parent that kills `taskIDs`. */
  function cascade(h: ReturnType<typeof harness>, taskIDs: string[]): void {
    h.tracker.noteOrchestratorBusy(PARENT);
    for (const taskID of taskIDs) {
      h.abortedLane(taskID);
      h.tracker.noteChildAbort(taskID, PARENT);
    }
    h.tracker.noteOrchestratorAbort(PARENT);
  }

  test('off (the default) attributes but never restarts anything', async () => {
    const h = harness();
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();

    expect(h.cascadeAt('child-1')).toBeDefined();
    expect(h.revived).toEqual([]);
    expect(h.timers).toHaveLength(0);
  });

  test('resumes the cascade lanes after the window plus the grace period', async () => {
    const h = autoHarness();
    cascade(h, ['child-1', 'child-2']);

    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.delay).toBe(CASCADE_WINDOW_MS + AUTO_REVIVE_DELAY_MS);

    await h.tracker.flushAutoRevive();
    expect(h.revived.sort()).toEqual(['child-1', 'child-2']);
    // Stamped BEFORE the prompt, so a lane that never comes back still counts.
    expect(h.board.get('child-1')?.lastAutoRevivedAt).toBeDefined();
  });

  test('never touches a lane that is not idle right now', async () => {
    const h = autoHarness({
      fetchSessionStatuses: async () => idleSnapshot(['child-2']),
    });
    cascade(h, ['child-1', 'child-2']);
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual(['child-1']);
  });

  test('an unreadable status snapshot restarts nothing', async () => {
    const h = autoHarness({
      fetchSessionStatuses: async () => idleSnapshot([], 'unreachable'),
    });
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual([]);
  });

  test('a post-cascade `omos lanes stop` vetoes the restart and labels the lane', async () => {
    const claimStopIntent = mock((sessionID: string) =>
      sessionID === 'child-1' ? { reason: 'I meant it' } : undefined,
    );
    const h = autoHarness({ claimStopIntent });
    cascade(h, ['child-1', 'child-2']);
    h.advance(CASCADE_WINDOW_MS + AUTO_REVIVE_DELAY_MS);
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual(['child-2']);
    expect(h.board.get('child-1')?.cancelledByUser).toMatchObject({
      reason: 'I meant it',
    });
    // Claimed only for intents written AFTER the cascade.
    expect(claimStopIntent.mock.calls[0]?.[1]).toBe(
      CASCADE_WINDOW_MS + AUTO_REVIVE_DELAY_MS,
    );
  });

  test('a second ESC cancels the pending restart', async () => {
    const h = autoHarness();
    cascade(h, ['child-1', 'child-2']);
    expect(h.timers).toHaveLength(1);

    // Every lane is already dead, so the second press produces a cascade with
    // zero candidates — which is exactly what "no, stay stopped" looks like.
    h.advance(CASCADE_WINDOW_MS + 1);
    h.tracker.noteOrchestratorAbort(PARENT);

    await h.tracker.flushAutoRevive();
    expect(h.revived).toEqual([]);
  });

  test('a repeat abort INSIDE the same window does not cancel its own restart', async () => {
    const h = autoHarness();
    cascade(h, ['child-1']);
    h.advance(100);
    h.tracker.noteOrchestratorAbort(PARENT);

    await h.tracker.flushAutoRevive();
    expect(h.revived).toEqual(['child-1']);
  });

  test('one lane is restarted at most once per cascade', async () => {
    const h = autoHarness();
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();
    // Re-run the same cascade: the ledger, not the board state, is what stops
    // a second prompt (the lane is running again by now anyway).
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual(['child-1']);
  });

  test('the per-lane cooldown closes the ESC -> revive -> ESC loop', async () => {
    const h = autoHarness();
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();
    expect(h.revived).toEqual(['child-1']);

    // The lane comes back, gets killed by a SECOND ESC minutes later: a brand
    // new cascade with a brand new ledger, so only the cooldown can stop it.
    h.advance(60_000);
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();
    expect(h.revived).toEqual(['child-1']);

    h.advance(AUTO_REVIVE_COOLDOWN_MS);
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();
    expect(h.revived).toEqual(['child-1', 'child-1']);
  });

  test('a lane with no cascade stamp is never restarted', async () => {
    const h = autoHarness();
    h.abortedLane('child-1');
    cascade(h, ['child-2']);
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual(['child-2']);
  });

  test('a failing restart is logged, not retried, and still counts', async () => {
    const h = autoHarness({
      reviveLane: async () => {
        throw new Error('promptAsync refused');
      },
    });
    cascade(h, ['child-1']);
    await h.tracker.flushAutoRevive();
    await h.tracker.flushAutoRevive();

    expect(h.board.get('child-1')?.lastAutoRevivedAt).toBeDefined();
    expect(h.board.get('child-1')?.state).toBe('error');
  });

  test('dispose cancels everything pending', async () => {
    const h = autoHarness();
    cascade(h, ['child-1']);
    h.tracker.dispose();
    await h.tracker.flushAutoRevive();

    expect(h.revived).toEqual([]);
    expect(h.timers).toHaveLength(0);
  });
});
