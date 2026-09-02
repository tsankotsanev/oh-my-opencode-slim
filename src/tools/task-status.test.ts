import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskStatusTool } from './task-status';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

function makeTool(options: {
  board: BackgroundJobBoard;
  now?: () => number;
  statusTimeoutMs?: number;
}) {
  return createTaskStatusTool({
    input: { directory: '/test' } as any,
    backgroundJobBoard: options.board,
    now: options.now,
    statusTimeoutMs: options.statusTimeoutMs,
  });
}

describe('task_status', () => {
  test('reads a child status without prompting it', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'busy' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: busy');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('includes guidance for active states (retry, running)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'retry' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: retry');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
  });

  test('flags a busy child the board has marked silent as possibly stuck', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    // The board owns the verdict: silence detection already applied the
    // threshold and the tool/retry/input-wait exemptions.
    board.markSilenceDetected('ses_child1', 'no activity for 305s while busy', {
      now: 305_000,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 320_000 });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('possibly_stuck: true');
  });

  test('does not flag a busy child that is merely idle-looking to a raw timer', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    // Long past the old 120s tracker threshold, but the board never flagged
    // it (streaming reply, long tool call, provider retry, permission wait).
    const { task_status } = makeTool({ board, now: () => 900_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('possibly_stuck: false');
    expect(output).toContain('idle_for_seconds: 900');
  });

  test('reads idle seconds from the board activity clock', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    board.recordActivity('ses_child1', 60_000);
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 100_000 });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('idle_for_seconds: 40');
  });

  test('surfaces a failed status read as explicit uncertainty, not a confident board fallback', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => {
          throw new Error('host status read failed');
        }),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error: host status read failed');
    expect(output).not.toContain('[guidance]: The task is still running.');
    // An uncertain board fallback must never drive an automatic nudge.
    expect(output).toContain('possibly_stuck: false');
  });

  test('treats a malformed live status entry as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'weird-state' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: malformed live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('bounds a hanging status read with a timeout and reports uncertainty', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        // Responds far slower than the bounded read allows; the 20ms race
        // timer must reject first so the tool cannot hang on a stuck host.
        status: mock(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ data: { ses_child1: { type: 'busy' } } }),
                200,
              ),
            ),
        ),
      },
    };
    const { task_status } = makeTool({ board, statusTimeoutMs: 20 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error');
    expect(output).toContain('timed out');
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('reports an absent session in a valid map as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = { session: { status: mock(async () => ({ data: {} })) } };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: no live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('rejects a task id owned by a different parent', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const { task_status } = makeTool({ board });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-2',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias');
  });
});
