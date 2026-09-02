import { describe, expect, mock, test } from 'bun:test';
import { isReviveableRetainedJob } from '../../tools/task-revive';
import { createTaskStatusTool } from '../../tools/task-status';
import { BackgroundJobBoard } from '../../utils';
import {
  isTransportError,
  transportSessionErrorReason,
} from '../../utils/session-error';
import { handleEvent } from './event-router';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';
import {
  captureLaneProgress,
  createSilenceMonitor,
  type LaneMessagesProbe,
  pendingToolCall,
  silenceReasonText,
} from './silence-detection';

const STALE_AFTER_MS = 300_000;
const LAUNCH_AT = 1_000_000;

/** A fake clock: every test drives time explicitly, nothing sleeps. */
function clock(start: number) {
  let current = start;
  return {
    now: () => current,
    set(next: number) {
      current = next;
    },
    advance(deltaMs: number) {
      current += deltaMs;
    },
  };
}

function assistantMessage(options: {
  text?: string;
  tools?: Array<{ name: string; status: string }>;
}) {
  return {
    info: { role: 'assistant', id: 'msg_1' },
    parts: [
      ...(options.text ? [{ type: 'text', text: options.text }] : []),
      ...(options.tools ?? []).map((tool, index) => ({
        id: `prt_${index}`,
        type: 'tool',
        tool: tool.name,
        state: { status: tool.status },
      })),
    ],
  };
}

interface Harness {
  status: () => Promise<unknown>;
  probeResult?: LaneMessagesProbe;
  silenceDetection?: boolean;
  hasInputWait?: (sessionID: string) => boolean;
  staleAfterMs?: number;
  toolStaleAfterMs?: number;
  time: ReturnType<typeof clock>;
}

function createHarness(harness: Harness) {
  const board = new BackgroundJobBoard();
  const probe = mock(
    async (): Promise<LaneMessagesProbe> =>
      harness.probeResult ?? { messages: [] },
  );
  const reconciler = createRuntimeStatusReconciler({
    input: {
      directory: '/test/project',
      client: { session: { status: harness.status } },
    } as never,
    backgroundJobBoard: board,
    silenceDetection: harness.silenceDetection,
    staleAfterMs: harness.staleAfterMs ?? STALE_AFTER_MS,
    silenceToolStaleAfterMs: harness.toolStaleAfterMs,
    hasInputWait: harness.hasInputWait,
    silenceNow: harness.time.now,
    silenceProbe: probe,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(['child-1']),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
  });
  const record = board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'port silence detection',
    now: LAUNCH_AT,
  });
  return { board, reconciler, probe, generation: record.generation };
}

const busyStatus = async () => ({ data: { 'child-1': { type: 'busy' } } });

/**
 * Drive one reconciliation pass with the monitor's clock at `at`.
 *
 * The reconciler reads wall-clock time for its own generation fencing, which
 * these tests do not exercise; only the injected `silenceNow` feeds the
 * silence clock.
 */
async function pass(
  fixture: ReturnType<typeof createHarness>,
  time: ReturnType<typeof clock>,
  at: number,
): Promise<void> {
  time.set(at);
  await fixture.reconciler.reconcile();
}

describe('silence detection: flagging a busy-but-silent lane', () => {
  test('flags the lane as status uncertain past the threshold', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'Reading the reconciliation module',
            tools: [{ name: 'bash', status: 'completed' }],
          }),
        ],
      },
    });

    // First seen busy: the baseline floor, not yet silent.
    await pass(fixture, time, LAUNCH_AT);
    expect(fixture.board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(fixture.probe).not.toHaveBeenCalled();

    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);

    const flagged = fixture.board.get('child-1');
    expect(flagged).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'no activity for 305s while busy',
      silenceReason: 'no activity for 305s while busy',
    });
    expect(flagged?.silenceDetectedAt).toBe(LAUNCH_AT + STALE_AFTER_MS + 5_000);
    expect(flagged?.lastProgress).toMatchObject({
      text: 'Reading the reconciliation module',
      lastTool: { name: 'bash', status: 'completed' },
      messageCount: 1,
    });
    expect(fixture.probe).toHaveBeenCalledTimes(1);
  });

  test('renders a Last seen line with no age or clock text', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'Reading the reconciliation module',
            tools: [{ name: 'bash', status: 'completed' }],
          }),
        ],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);

    const rendered = fixture.board.formatForPrompt('parent-1');
    expect(rendered).toContain('running, status uncertain');
    expect(rendered).toContain('Status: no activity for 305s while busy');
    expect(rendered).toContain(
      'Last seen: Reading the reconciliation module (last tool: bash completed, 1 msg)',
    );
  });

  test('keeps the reason frozen and the render byte-identical over time', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [assistantMessage({ text: 'still thinking' })],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 1_000);
    const first = fixture.board.formatForPrompt('parent-1');
    const firstReason = fixture.board.get('child-1')?.lastStatusError;

    // Many more cycles, and long enough for a permitted re-probe.
    for (const at of [
      LAUNCH_AT + STALE_AFTER_MS + 6_000,
      LAUNCH_AT + STALE_AFTER_MS + 11_000,
      LAUNCH_AT + 4 * STALE_AFTER_MS,
      LAUNCH_AT + 8 * STALE_AFTER_MS,
    ]) {
      await pass(fixture, time, at);
    }

    expect(fixture.board.get('child-1')?.lastStatusError).toBe(firstReason);
    expect(fixture.board.formatForPrompt('parent-1')).toBe(first);
  });

  test('re-probes at most once per staleAfterMs per lane', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { messages: [assistantMessage({ text: 'quiet' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 1_000);
    expect(fixture.probe).toHaveBeenCalledTimes(1);

    // Well past the silence threshold but inside the probe budget.
    for (const at of [
      LAUNCH_AT + STALE_AFTER_MS + 6_000,
      LAUNCH_AT + STALE_AFTER_MS + 60_000,
      LAUNCH_AT + 2 * STALE_AFTER_MS,
    ]) {
      await pass(fixture, time, at);
    }
    expect(fixture.probe).toHaveBeenCalledTimes(1);

    await pass(fixture, time, LAUNCH_AT + 2 * STALE_AFTER_MS + 2_000);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });
});

describe('silence detection: exemptions', () => {
  test('an unfinished tool part exempts the lane', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'running the suite',
            tools: [{ name: 'bash', status: 'running' }],
          }),
        ],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);

    const job = fixture.board.get('child-1');
    expect(job).toMatchObject({ state: 'running', statusUncertain: false });
    expect(job?.silenceDetectedAt).toBeUndefined();
    // Progress is still captured so the parent can see the blocking tool.
    expect(job?.lastProgress).toMatchObject({
      lastTool: { name: 'bash', status: 'running' },
    });
  });

  test('an earlier parallel tool call still counts as unfinished', () => {
    const messages = [
      assistantMessage({
        tools: [
          { name: 'bash', status: 'running' },
          { name: 'read', status: 'completed' },
        ],
      }),
    ];
    expect(pendingToolCall(messages)).toEqual({
      name: 'bash',
      status: 'running',
    });
  });

  test('a tool call past the internal backstop is flagged after all', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      toolStaleAfterMs: 600_000,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'running the suite',
            tools: [{ name: 'bash', status: 'running' }],
          }),
        ],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + 700_000);

    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: true,
      lastStatusError: 'no activity for 700s while awaiting tool bash',
    });
  });

  test('a retrying provider exempts the lane and restarts the clock', async () => {
    const time = clock(LAUNCH_AT);
    let live: unknown = { data: { 'child-1': { type: 'retry' } } };
    const fixture = createHarness({
      status: async () => live,
      time,
      probeResult: { messages: [assistantMessage({ text: 'x' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);

    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: false,
    });

    // The retry ended; the silence clock restarted from the last retry pass.
    live = { data: { 'child-1': { type: 'busy' } } };
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 6_000);
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: false,
    });
  });

  test('a lane awaiting user input is never probed', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      hasInputWait: (sessionID) => sessionID === 'child-1',
      probeResult: { messages: [assistantMessage({ text: 'x' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + 10 * STALE_AFTER_MS);

    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: false,
    });
  });

  test('disabled silence detection never probes or flags', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      silenceDetection: false,
      probeResult: { messages: [assistantMessage({ text: 'x' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + 10 * STALE_AFTER_MS);

    expect(fixture.probe).not.toHaveBeenCalled();
    const job = fixture.board.get('child-1');
    expect(job).toMatchObject({ state: 'running', statusUncertain: false });
    expect(job?.silenceDetectedAt).toBeUndefined();
    expect(job?.lastProgress).toBeUndefined();
  });

  test('a failed probe proves nothing and flags nothing', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { error: 'Lane message probe timed out' },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);

    expect(fixture.probe).toHaveBeenCalledTimes(1);
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: false,
    });
  });
});

describe('silence detection: activity keeps a lane alive', () => {
  test('streamed deltas keep a slow lane out of the silence window', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { messages: [assistantMessage({ text: 'x' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    // A long streamed reply: deltas are the only event a healthy lane emits.
    for (let at = LAUNCH_AT; at <= LAUNCH_AT + 900_000; at += 60_000) {
      fixture.board.recordActivity('child-1', at);
      await pass(fixture, time, at);
    }

    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: false,
    });
  });

  test('activity clears the flag, its reason and the stale excerpt', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { messages: [assistantMessage({ text: 'was quiet' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 5_000);
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: true,
    });

    fixture.board.recordActivity('child-1', LAUNCH_AT + STALE_AFTER_MS + 6_000);

    const revived = fixture.board.get('child-1');
    expect(revived).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(revived?.lastStatusError).toBeUndefined();
    expect(revived?.silenceReason).toBeUndefined();
    expect(revived?.silenceDetectedAt).toBeUndefined();
    expect(revived?.lastProgress).toBeUndefined();
    expect(fixture.board.formatForPrompt('parent-1')).not.toContain(
      'Last seen',
    );
  });

  test('the liveness poller cannot clear a silence flag with its own busy read', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { messages: [assistantMessage({ text: 'frozen' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    await pass(fixture, time, LAUNCH_AT + STALE_AFTER_MS + 1_000);
    expect(fixture.board.get('child-1')).toMatchObject({
      statusUncertain: true,
    });

    // markRunningFromLiveSession runs on every one of these busy passes.
    for (const at of [
      LAUNCH_AT + STALE_AFTER_MS + 6_000,
      LAUNCH_AT + STALE_AFTER_MS + 11_000,
    ]) {
      await pass(fixture, time, at);
    }

    expect(fixture.board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'no activity for 301s while busy',
    });
  });
});

describe('silence detection: activity heartbeat wiring', () => {
  function eventDeps(board: BackgroundJobBoard, now: () => number) {
    return {
      inputWaits: {
        trackInputWait: () => {},
        clearInputWaits: () => {},
        waitsByParent: new Map<string, Set<string | symbol>>(),
      },
      idleSessionTokens: {
        clearSession: () => {},
        invalidate: () => {},
        disposeLocalState: () => {},
        sessionTokens: new Map<string, symbol>(),
      },
      options: { shouldManageSession: () => false, now },
      idleReconciler: {
        scheduleIdleReconciliation: () => {},
        scheduleChildIdleReconciliation: () => {},
        scheduleErrorTerminalize: () => {},
        clearIdleTimers: () => {},
        clearAllTimers: () => [],
      },
      deferredInlineErrors: new Set<string>(),
      backgroundJobBoard: board,
      pendingCallTracker: {
        peekByParentAndAgent: () => undefined,
        clearSession: () => {},
      },
      taskContextTracker: {
        pendingManagedTaskIds: new Set<string>(),
        clearSession: () => {},
        prune: () => {},
      },
      terminalJobsInjectedByParent: new Map(),
      pendingInjectedTerminalJobsByParent: new Map(),
      retainedBoardSnapshots: new Map(),
    } as never;
  }

  function boardWithLane() {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'heartbeat',
      now: LAUNCH_AT,
    });
    return board;
  }

  test.each([
    [
      'message.part.delta',
      { sessionID: 'child-1', messageID: 'msg_1', partID: 'prt_1' },
    ],
    [
      'message.part.updated',
      { part: { sessionID: 'child-1', id: 'prt_1', type: 'text' } },
    ],
    [
      'message.updated',
      { info: { id: 'msg_1', sessionID: 'child-1', role: 'assistant' } },
    ],
  ])('%s records the activity heartbeat', async (type, properties) => {
    const board = boardWithLane();
    const at = LAUNCH_AT + 42_000;

    await handleEvent(
      { event: { type, properties } } as never,
      eventDeps(board, () => at),
    );

    expect(board.get('child-1')?.lastActivityAt).toBe(at);
  });

  test('session.status busy seeds the activity clock', async () => {
    const board = boardWithLane();
    const at = LAUNCH_AT + 7_000;

    await handleEvent(
      {
        event: {
          type: 'session.status',
          properties: { sessionID: 'child-1', status: { type: 'busy' } },
        },
      } as never,
      eventDeps(board, () => at),
    );

    expect(board.get('child-1')?.lastActivityAt).toBe(at);
  });

  test('an unknown session is a no-op', async () => {
    const board = boardWithLane();

    await handleEvent(
      {
        event: {
          type: 'message.part.delta',
          properties: { sessionID: 'not-tracked' },
        },
      } as never,
      eventDeps(board, () => LAUNCH_AT + 1_000),
    );

    expect(board.get('not-tracked')).toBeUndefined();
    expect(board.get('child-1')?.lastActivityAt).toBeUndefined();
  });

  test('a heartbeat never moves the clock backwards', () => {
    const board = boardWithLane();
    board.recordActivity('child-1', LAUNCH_AT + 10_000);
    board.recordActivity('child-1', LAUNCH_AT + 5_000);
    expect(board.get('child-1')?.lastActivityAt).toBe(LAUNCH_AT + 10_000);
  });

  test('a message injected INTO the lane is not lane activity', async () => {
    const board = boardWithLane();
    board.markSilenceDetected('child-1', 'no activity for 305s while busy', {
      now: LAUNCH_AT + 305_000,
      progress: { messageCount: 3, capturedAt: LAUNCH_AT + 305_000 },
    });
    const at = LAUNCH_AT + 400_000;
    const deps = eventDeps(board, () => at);

    // task_message / `omo lanes say` prompting a hung child: the host emits a
    // user message plus its part events. None of it is output BY the lane.
    await handleEvent(
      {
        event: {
          type: 'message.updated',
          properties: {
            info: { id: 'msg_user_1', sessionID: 'child-1', role: 'user' },
          },
        },
      } as never,
      deps,
    );
    await handleEvent(
      {
        event: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'child-1',
            messageID: 'msg_user_1',
            partID: 'prt_1',
          },
        },
      } as never,
      deps,
    );
    await handleEvent(
      {
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'child-1',
              messageID: 'msg_user_1',
              id: 'prt_1',
              type: 'text',
            },
          },
        },
      } as never,
      deps,
    );

    const stillSilent = board.get('child-1');
    expect(stillSilent?.statusUncertain).toBe(true);
    expect(stillSilent?.silenceDetectedAt).toBe(LAUNCH_AT + 305_000);
    expect(stillSilent?.lastStatusError).toBe(
      'no activity for 305s while busy',
    );
    expect(stillSilent?.lastActivityAt).toBeUndefined();

    // The lane's OWN reply carries a different message id and does revive it.
    await handleEvent(
      {
        event: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'child-1',
            messageID: 'msg_assistant_1',
            partID: 'prt_2',
          },
        },
      } as never,
      deps,
    );
    expect(board.get('child-1')).toMatchObject({
      statusUncertain: false,
      lastActivityAt: at,
    });
  });

  test('an assistant message.updated still counts as activity', async () => {
    const board = boardWithLane();
    const at = LAUNCH_AT + 30_000;

    await handleEvent(
      {
        event: {
          type: 'message.updated',
          properties: {
            info: { id: 'msg_1', sessionID: 'child-1', role: 'assistant' },
          },
        },
      } as never,
      eventDeps(board, () => at),
    );

    expect(board.get('child-1')?.lastActivityAt).toBe(at);
  });
});

describe('silence detection: child transport errors', () => {
  function transportDeps(board: BackgroundJobBoard) {
    return {
      inputWaits: {
        trackInputWait: () => {},
        clearInputWaits: () => {},
        waitsByParent: new Map<string, Set<string | symbol>>(),
      },
      idleSessionTokens: {
        clearSession: () => {},
        invalidate: () => {},
        disposeLocalState: () => {},
        sessionTokens: new Map<string, symbol>(),
      },
      // The child is not an orchestrator: this is the child error branch.
      options: { shouldManageSession: () => false, now: () => LAUNCH_AT + 100 },
      idleReconciler: {
        scheduleIdleReconciliation: () => {},
        scheduleChildIdleReconciliation: () => {},
        scheduleErrorTerminalize: () => {},
        clearIdleTimers: () => {},
        clearAllTimers: () => [],
      },
      deferredInlineErrors: new Set<string>(),
      backgroundJobBoard: board,
      pendingCallTracker: {
        peekByParentAndAgent: () => undefined,
        clearSession: () => {},
      },
      taskContextTracker: {
        pendingManagedTaskIds: new Set<string>(),
        clearSession: () => {},
        prune: () => {},
      },
      terminalJobsInjectedByParent: new Map(),
      pendingInjectedTerminalJobsByParent: new Map(),
      retainedBoardSnapshots: new Map(),
    } as never;
  }

  function laneBoard() {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'transport',
      now: LAUNCH_AT,
    });
    return board;
  }

  test('a transport fault stays revivable error, naming the cause', async () => {
    const board = laneBoard();

    await handleEvent(
      {
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'child-1',
            error: { name: 'UnknownError', message: 'fetch failed' },
          },
        },
      } as never,
      transportDeps(board),
    );

    const job = board.get('child-1');
    if (!job) throw new Error('lane missing');
    // `error`, not `statusUncertain`: statusUncertain leaves the record
    // `running`, the child then goes idle, and stop-confirmation converts it
    // to `stopped` after its grace — which is NOT revivable and loses the
    // transport cause. `error` keeps the same session resumable in place.
    expect(job.state).toBe('error');
    expect(job.statusUncertain).toBe(false);
    expect(job.resultSummary).toBe(
      'Child session lost its transport connection (fetch failed); the task outcome is unknown.',
    );
    expect(isReviveableRetainedJob(job)).toBe(true);
  });

  test('a transport fault does not become an unrevivable stopped record', async () => {
    const board = laneBoard();

    await handleEvent(
      {
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'child-1',
            error: { code: 'ECONNRESET' },
          },
        },
      } as never,
      transportDeps(board),
    );

    // The child goes idle right after the error; stop-confirmation may only
    // act on a `running` record, so the terminal error is already safe.
    const stopped = board.markStopped(
      'child-1',
      'Background session stopped before a terminal task result was received.',
      LAUNCH_AT + 10_000,
    );
    expect(stopped?.state).toBe('error');
    expect(stopped?.resultSummary).toContain('lost its transport connection');
    if (!stopped) throw new Error('lane missing');
    expect(isReviveableRetainedJob(stopped)).toBe(true);
  });

  test('a genuine task failure is still terminal error', async () => {
    const board = laneBoard();

    await handleEvent(
      {
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'child-1',
            error: { name: 'UnknownError', message: 'tool crashed' },
          },
        },
      } as never,
      transportDeps(board),
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'tool crashed',
    });
  });

  test.each([
    [{ code: 'ECONNRESET' }],
    [{ message: 'read ECONNRESET' }],
    [{ code: 'ENOTFOUND' }],
    [{ code: 'ETIMEDOUT' }],
    [{ code: 'EAI_AGAIN' }],
    [{ code: 'ECONNREFUSED' }],
    [{ message: 'fetch failed' }],
    [{ message: 'socket hang up' }],
    [{ message: 'request timeout' }],
    [{ code: 'UND_ERR_SOCKET' }],
    [{ data: { message: 'fetch failed' } }],
  ])('classifies %o as a transport fault', (error) => {
    expect(isTransportError(error)).toBe(true);
    expect(transportSessionErrorReason(error)).toContain('transport');
  });

  test.each([
    [undefined],
    [{}],
    [{ message: 'I could not fetch failed dependencies' }],
    [{ name: 'ProviderAuthError', message: 'invalid api key' }],
    [{ message: 'the model refused the request' }],
    // An abort is a cut-short lane, not a broken wire.
    [{ name: 'MessageAbortedError', message: 'read ECONNRESET' }],
  ])('does not classify %o as a transport fault', (error) => {
    expect(isTransportError(error)).toBe(false);
  });
});

describe('silence detection: pure helpers', () => {
  test('captureLaneProgress reads the newest text and tool', () => {
    const progress = captureLaneProgress(
      [
        assistantMessage({ text: 'older', tools: [] }),
        assistantMessage({
          text: 'newest',
          tools: [{ name: 'edit', status: 'completed' }],
        }),
      ],
      500,
    );
    expect(progress).toEqual({
      text: 'newest',
      lastTool: { name: 'edit', status: 'completed' },
      messageCount: 2,
      capturedAt: 500,
    });
  });

  test('captureLaneProgress bounds the excerpt at 300 chars', () => {
    const progress = captureLaneProgress(
      [assistantMessage({ text: 'x'.repeat(1_000) })],
      1,
    );
    expect(progress.text).toHaveLength(300);
  });

  test('captureLaneProgress still stamps an empty log', () => {
    expect(captureLaneProgress([], 7)).toEqual({
      messageCount: 0,
      capturedAt: 7,
    });
  });

  test('pendingToolCall ignores a finished tail message', () => {
    expect(
      pendingToolCall([
        assistantMessage({ tools: [{ name: 'bash', status: 'completed' }] }),
      ]),
    ).toBeUndefined();
    expect(
      pendingToolCall([{ info: { role: 'user' }, parts: [] }]),
    ).toBeUndefined();
    expect(pendingToolCall([])).toBeUndefined();
  });

  test('silenceReasonText rounds to whole seconds', () => {
    expect(silenceReasonText(305_400)).toBe('no activity for 305s while busy');
    expect(silenceReasonText(305_400, { name: 'bash' })).toBe(
      'no activity for 305s while awaiting tool bash',
    );
  });

  test('a monitor built with a sub-floor threshold is clamped to the floor', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'clamp',
      now: LAUNCH_AT,
    });
    const probe = mock(async () => ({ messages: [] }) as LaneMessagesProbe);
    const laneClock = clock(LAUNCH_AT);
    const monitor = createSilenceMonitor({
      backgroundJobBoard: board,
      input: {} as never,
      staleAfterMs: 1,
      now: laneClock.now,
      probe,
    });

    const job = board.get('child-1');
    if (!job) throw new Error('lane missing');
    await monitor.observe(job, 'busy');

    // 9s of silence is under the 10s floor even though 1ms was requested.
    laneClock.set(LAUNCH_AT + 9_000);
    await monitor.observe(job, 'busy');
    expect(probe).not.toHaveBeenCalled();

    laneClock.set(LAUNCH_AT + 11_000);
    await monitor.observe(job, 'busy');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

/**
 * The board is the single activity clock.
 *
 * `task_status` used to read a separate in-memory tracker with its own event
 * set and a flat 120s threshold, so it could call a lane stuck while the
 * rendered job board called it running (and vice versa). Both now read the
 * same record, which means the tool inherits the board's tool-executing and
 * retry exemptions for free. These tests pin that agreement.
 */
describe('silence detection: task_status agrees with the board', () => {
  async function agreement(fixture: {
    board: BackgroundJobBoard;
    at: number;
  }): Promise<{ status: string; rendered: string }> {
    const { task_status } = createTaskStatusTool({
      // `session.status` present on the client, so the bounded read never
      // falls back to the real getClient().
      input: {
        directory: '/test/project',
        client: {
          session: {
            status: async () => ({ data: { 'child-1': { type: 'busy' } } }),
          },
        },
      } as never,
      backgroundJobBoard: fixture.board,
      now: () => fixture.at,
    });
    const status = await task_status.execute({ task_id: 'child-1' }, {
      sessionID: 'parent-1',
    } as never);
    return {
      status: status as string,
      rendered: fixture.board.formatForPrompt('parent-1') ?? '',
    };
  }

  test('a streaming lane is running for both', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: { messages: [assistantMessage({ text: 'x' })] },
    });

    await pass(fixture, time, LAUNCH_AT);
    let at = LAUNCH_AT;
    for (; at <= LAUNCH_AT + 900_000; at += 60_000) {
      fixture.board.recordActivity('child-1', at);
      await pass(fixture, time, at);
    }

    const { status, rendered } = await agreement({ board: fixture.board, at });
    expect(status).toContain('possibly_stuck: false');
    expect(status).toContain('state: busy');
    expect(rendered).not.toContain('status uncertain');
    expect(rendered).not.toContain('Last seen');
  });

  test('a tool-executing lane is running for both', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'running the suite',
            tools: [{ name: 'bash', status: 'running' }],
          }),
        ],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    const at = LAUNCH_AT + STALE_AFTER_MS + 5_000;
    await pass(fixture, time, at);

    const { status, rendered } = await agreement({ board: fixture.board, at });
    // The old flat timer would have called this stuck at 120s.
    expect(status).toContain('possibly_stuck: false');
    expect(rendered).not.toContain('status uncertain');
    expect(rendered).not.toContain('Last seen');
  });

  test('a genuinely silent lane is flagged for both', async () => {
    const time = clock(LAUNCH_AT);
    const fixture = createHarness({
      status: busyStatus,
      time,
      probeResult: {
        messages: [
          assistantMessage({
            text: 'Reading the reconciliation module',
            tools: [{ name: 'bash', status: 'completed' }],
          }),
        ],
      },
    });

    await pass(fixture, time, LAUNCH_AT);
    const at = LAUNCH_AT + STALE_AFTER_MS + 5_000;
    await pass(fixture, time, at);

    const { status, rendered } = await agreement({ board: fixture.board, at });
    expect(status).toContain('possibly_stuck: true');
    expect(status).toContain('state: busy');
    expect(rendered).toContain('running, status uncertain');
    expect(rendered).toContain(
      'Last seen: Reading the reconciliation module (last tool: bash completed, 1 msg)',
    );
  });
});
