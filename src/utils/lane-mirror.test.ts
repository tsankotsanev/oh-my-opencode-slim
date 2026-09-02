import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobBoard } from './background-job-board';
import {
  canonicalDirectory,
  claimLaneWriters,
  createLaneMirror,
  LANE_MIRROR_VERSION,
  laneMirrorPath,
  laneStateDir,
  laneStateKey,
  readLaneMirror,
  releaseLaneWriters,
  toLaneMirrorRecord,
  writeLaneMirror,
} from './lane-mirror';

let dataHome: string;
let projectDir: string;
let originalDataHome: string | undefined;

beforeEach(() => {
  originalDataHome = process.env.XDG_DATA_HOME;
  dataHome = mkdtempSync(path.join(os.tmpdir(), 'lane-mirror-data-'));
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'lane-mirror-project-'));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function seedRunningLane(board = new BackgroundJobBoard()) {
  const record = board.registerLaunch({
    taskID: 'ses_child1',
    parentSessionID: 'ses_parent',
    agent: 'fixer',
    description: 'fix the parser',
    objective: 'fix the parser end to end',
    background: true,
    now: 1_000,
  });
  return { board, record };
}

describe('lane state paths', () => {
  test('mirror lives under the plugin data root used by the companion', () => {
    expect(laneStateDir()).toBe(
      path.join(
        dataHome,
        'opencode',
        'storage',
        'oh-my-opencode-slim',
        'background-jobs',
      ),
    );
    expect(laneMirrorPath(projectDir)).toBe(
      path.join(laneStateDir(), `${laneStateKey(projectDir)}.json`),
    );
  });

  test('key is the first 16 hex chars of sha256(canonical dir)', () => {
    const key = laneStateKey(projectDir);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(laneStateKey(`${projectDir}/.`)).toBe(key);
  });

  test('two spellings of one directory (symlink) agree', () => {
    const link = path.join(dataHome, 'linked-project');
    symlinkSync(projectDir, link);
    expect(canonicalDirectory(link)).toBe(canonicalDirectory(projectDir));
    expect(laneStateKey(link)).toBe(laneStateKey(projectDir));
  });

  test('a missing directory still hashes (no throw)', () => {
    const missing = path.join(projectDir, 'gone', 'deeper');
    expect(laneStateKey(missing)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('different projects never share a mirror', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'lane-mirror-other-'));
    try {
      expect(laneMirrorPath(other)).not.toBe(laneMirrorPath(projectDir));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('toLaneMirrorRecord', () => {
  test('projects the fields the CLI needs and nothing else', () => {
    const { board, record } = seedRunningLane();
    board.markAwaitingPermission(record.taskID, {
      tool: 'bash',
      permissionID: 'per_1',
      now: 2_000,
    });
    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );

    expect(mirrored).toMatchObject({
      alias: 'fix-1',
      sessionID: 'ses_child1',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      state: 'running',
      statusUncertain: false,
      cancellationRequested: false,
      terminalUnreconciled: false,
    });
    // Nothing about leases, generations or context files leaks into the copy,
    // and the permission request id is stripped (it only fences the plugin's
    // own clear).
    expect(Object.keys(mirrored).sort()).toEqual([
      'agent',
      'alias',
      'awaitingPermission',
      'cancellationRequested',
      'label',
      'launchedAt',
      'objective',
      'parentSessionID',
      'sessionID',
      'state',
      'statusUncertain',
      'terminalUnreconciled',
      'updatedAt',
    ]);
    expect(mirrored.awaitingPermission).toEqual({ tool: 'bash', at: 2_000 });
  });

  test('carries the user-stop label and the terminal summary', () => {
    const { board, record } = seedRunningLane();
    board.updateStatus({
      taskID: record.taskID,
      state: 'error',
      resultSummary: 'MessageAbortedError',
    });
    board.markCancelledByUser(record.taskID, 'wrong file set', 5_000);
    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );
    expect(mirrored.state).toBe('error');
    expect(mirrored.resultSummary).toBe('MessageAbortedError');
    expect(mirrored.cancelledByUser).toEqual({
      at: 5_000,
      reason: 'wrong file set',
    });
  });

  test('carries the cascade stamp, which is how --cascade picks a group', () => {
    const { board, record } = seedRunningLane();
    board.updateStatus({ taskID: record.taskID, state: 'error' });
    board.markCascade(record.taskID, {
      parentSessionID: 'ses_parent',
      at: 7_000,
    });
    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );

    // `at` is the cascade's identity: the CLI selects the newest group by it.
    expect(mirrored.killedByCascade).toEqual({
      parentSessionID: 'ses_parent',
      at: 7_000,
    });
  });

  test('carries the reconciled outcome so the CLI shares one revive rule', () => {
    const { board, record } = seedRunningLane();
    board.updateStatus({
      taskID: record.taskID,
      state: 'completed',
      resultSummary: 'done',
    });
    board.markReconciled(record.taskID);
    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );

    expect(mirrored.state).toBe('reconciled');
    // Without this, `isReviveableRetainedJob` would disagree between the tool
    // and the CLI for exactly the reconciled records.
    expect(mirrored.terminalState).toBe('completed');
  });

  test('publishes the user-revive label for a resumed lane', () => {
    const { board, record } = seedRunningLane();
    board.markRevivedByUser(record.taskID, 8_000);
    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );

    expect(mirrored.revivedByUser).toEqual({ at: 8_000 });
  });
});

describe('toLaneMirrorRecord field hygiene', () => {
  test('truncates unbounded free text and normalizes whitespace', () => {
    const { board, record } = seedRunningLane();
    board.registerLaunch({
      taskID: record.taskID,
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      description: 'fix   the\n parser',
      objective: 'o'.repeat(900),
      now: 2_000,
    });
    board.updateStatus({
      taskID: record.taskID,
      state: 'error',
      resultSummary: 'e'.repeat(900),
    });

    const mirrored = toLaneMirrorRecord(
      board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
    );
    expect(mirrored.label).toBe('fix the parser');
    expect(mirrored.objective).toHaveLength(300);
    expect(mirrored.objective?.endsWith('\u2026')).toBe(true);
    expect(mirrored.resultSummary).toHaveLength(300);
  });

  test('publishes cancellationRequested (a CLI refusal input)', () => {
    const { board, record } = seedRunningLane();
    board.claimWallClockDeadline({
      taskID: record.taskID,
      generation: record.generation,
    });
    expect(
      toLaneMirrorRecord(
        board.get(record.taskID) as NonNullable<ReturnType<typeof board.get>>,
      ).cancellationRequested,
    ).toBe(true);
  });
});

describe('readLaneMirror', () => {
  test('round-trips what the writer produced', () => {
    const file = laneMirrorPath(projectDir);
    const { board, record } = seedRunningLane();
    expect(
      writeLaneMirror(file, {
        version: LANE_MIRROR_VERSION,
        savedAt: 7,
        directory: canonicalDirectory(projectDir),
        lanes: board.list().map(toLaneMirrorRecord),
      }),
    ).toBe(true);

    const snapshot = readLaneMirror(file);
    expect(snapshot?.savedAt).toBe(7);
    expect(snapshot?.lanes[0]?.sessionID).toBe(record.taskID);
  });

  test('missing, corrupt and version-mismatched files read as undefined', () => {
    const file = laneMirrorPath(projectDir);
    expect(readLaneMirror(file)).toBeUndefined();

    writeLaneMirror(file, {
      version: LANE_MIRROR_VERSION + 1,
      savedAt: 1,
      directory: projectDir,
      lanes: [],
    });
    expect(readLaneMirror(file)).toBeUndefined();

    writeFileSync(file, '{not json', 'utf8');
    expect(readLaneMirror(file)).toBeUndefined();
  });

  test('an unwritable target reports false instead of throwing', () => {
    // A directory where the file should be makes the rename fail.
    const file = path.join(projectDir, 'blocked');
    mkdirSync(file, { recursive: true });
    expect(
      writeLaneMirror(file, {
        version: LANE_MIRROR_VERSION,
        savedAt: 1,
        directory: projectDir,
        lanes: [],
      }),
    ).toBe(false);
  });
});

describe('createLaneMirror', () => {
  function harness(options: { enabled?: boolean } = {}) {
    const { board } = seedRunningLane();
    let now = 10_000;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const mirror = createLaneMirror({
      directory: projectDir,
      enabled: options.enabled ?? true,
      lanes: () => board.list(),
      now: () => now,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        const timer = { fn, at: now + ms };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: ((timer: unknown) => {
        const index = timers.indexOf(timer as { fn: () => void; at: number });
        if (index >= 0) timers.splice(index, 1);
      }) as unknown as typeof clearTimeout,
    });
    return {
      board,
      mirror,
      advance(ms: number) {
        now += ms;
        for (const timer of [...timers]) {
          if (timer.at <= now) {
            timers.splice(timers.indexOf(timer), 1);
            timer.fn();
          }
        }
      },
      pendingTimers: () => timers.length,
      setNow(value: number) {
        now = value;
      },
    };
  }

  test('writes on the first flush and debounces the next second', () => {
    const h = harness();
    h.mirror.scheduleFlush();
    const first = readLaneMirror(h.mirror.file);
    expect(first?.lanes).toHaveLength(1);
    expect(first?.savedAt).toBe(10_000);

    // A second change inside the window is deferred, not written.
    h.board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'done',
    });
    h.mirror.scheduleFlush();
    expect(readLaneMirror(h.mirror.file)?.savedAt).toBe(10_000);
    expect(h.pendingTimers()).toBe(1);

    h.advance(1_000);
    const second = readLaneMirror(h.mirror.file);
    expect(second?.savedAt).toBe(11_000);
    expect(second?.lanes[0]?.state).toBe('completed');
  });

  test('records the canonical directory it describes', () => {
    const h = harness();
    h.mirror.flushNow();
    expect(readLaneMirror(h.mirror.file)?.directory).toBe(
      canonicalDirectory(projectDir),
    );
  });

  test('disabled writes nothing at all', () => {
    const h = harness({ enabled: false });
    h.mirror.scheduleFlush();
    h.mirror.flushNow();
    h.advance(5_000);
    h.mirror.dispose();
    expect(existsSync(h.mirror.file)).toBe(false);
  });

  test('dispose writes the final board state even with nothing pending', () => {
    const h = harness();
    h.board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    h.mirror.dispose();
    expect(readLaneMirror(h.mirror.file)?.lanes[0]?.state).toBe('completed');
  });

  test('dispose flushes pending state, then stops scheduling', () => {
    const h = harness();
    h.mirror.flushNow();
    h.board.updateStatus({ taskID: 'ses_child1', state: 'error' });
    h.mirror.scheduleFlush(); // debounced, still pending
    expect(readLaneMirror(h.mirror.file)?.lanes[0]?.state).toBe('running');

    h.mirror.dispose();
    expect(readLaneMirror(h.mirror.file)?.lanes[0]?.state).toBe('error');

    h.board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    h.mirror.scheduleFlush();
    h.mirror.flushNow();
    expect(readLaneMirror(h.mirror.file)?.lanes[0]?.state).toBe('error');
  });

  test('a throwing snapshot never propagates', () => {
    const mirror = createLaneMirror({
      directory: projectDir,
      enabled: true,
      lanes: () => {
        throw new Error('board exploded');
      },
    });
    expect(() => {
      mirror.flushNow();
    }).not.toThrow();
    expect(existsSync(mirror.file)).toBe(false);
  });

  test('onFlush failures never break the write', () => {
    const { board } = seedRunningLane();
    const mirror = createLaneMirror({
      directory: projectDir,
      enabled: true,
      lanes: () => board.list(),
      onFlush: () => {
        throw new Error('sidecar exploded');
      },
    });
    expect(() => {
      mirror.flushNow();
    }).not.toThrow();
    expect(readLaneMirror(mirror.file)?.lanes).toHaveLength(1);
  });

  test('skips the write when nothing about the lanes changed (S4)', () => {
    const h = harness();
    h.mirror.flushNow();
    const first = readLaneMirror(h.mirror.file);
    expect(first?.savedAt).toBe(10_000);

    // A flush with no board change must not rewrite the file, and must not
    // move `savedAt` — a reader would take that as "the board just moved".
    h.advance(5_000);
    h.mirror.flushNow();
    expect(readLaneMirror(h.mirror.file)?.savedAt).toBe(10_000);

    // A real change lands, stamped with the moment it changed.
    h.board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    h.mirror.flushNow();
    const second = readLaneMirror(h.mirror.file);
    expect(second?.savedAt).toBe(15_000);
    expect(second?.lanes[0]?.state).toBe('completed');
  });

  test('onBeforeFlush runs before the board is read, once per flush', () => {
    const { board } = seedRunningLane();
    const calls: string[] = [];
    const mirror = createLaneMirror({
      directory: projectDir,
      enabled: true,
      lanes: () => {
        calls.push('lanes');
        return board.list();
      },
      onBeforeFlush: () => {
        calls.push('before');
        board.updateStatus({ taskID: 'ses_child1', state: 'error' });
      },
      onFlush: () => calls.push('after'),
    });
    mirror.flushNow();
    expect(calls).toEqual(['before', 'lanes', 'after']);
    // The bookkeeping it did is visible in the file this flush wrote.
    expect(readLaneMirror(mirror.file)?.lanes[0]?.state).toBe('error');
  });

  test('a throwing onBeforeFlush never breaks the write', () => {
    const { board } = seedRunningLane();
    const mirror = createLaneMirror({
      directory: projectDir,
      enabled: true,
      lanes: () => board.list(),
      onBeforeFlush: () => {
        throw new Error('sweep exploded');
      },
    });
    expect(() => {
      mirror.flushNow();
    }).not.toThrow();
    expect(readLaneMirror(mirror.file)?.lanes).toHaveLength(1);
  });

  test('exposes no way to read the mirror back into a board', () => {
    const h = harness();
    // Guard against a future "just add load()" regression: the plugin must
    // keep rehydrating from the transcript, never from this file.
    expect(Object.keys(h.mirror).sort()).toEqual([
      'dispose',
      'file',
      'flushNow',
      'scheduleFlush',
    ]);
  });
});

describe('claimLaneWriters', () => {
  test('a new plugin generation disposes the previous writers', () => {
    const disposed: string[] = [];
    const first = () => disposed.push('first');
    const second = () => disposed.push('second');

    claimLaneWriters(projectDir, first);
    expect(disposed).toEqual([]);

    // The factory re-runs (config update): the old mirror timer and sidecar
    // heartbeat must not keep running against a board nobody reads.
    claimLaneWriters(projectDir, second);
    expect(disposed).toEqual(['first']);

    releaseLaneWriters(projectDir, second);
    claimLaneWriters(projectDir, first);
    expect(disposed).toEqual(['first']);
    releaseLaneWriters(projectDir, first);
  });

  test('two spellings of one directory are the same owner', () => {
    const disposed: string[] = [];
    const first = () => disposed.push('first');
    claimLaneWriters(projectDir, first);
    claimLaneWriters(`${projectDir}/.`, () => {});
    expect(disposed).toEqual(['first']);
  });

  test('a throwing predecessor does not stop the new generation', () => {
    claimLaneWriters(projectDir, () => {
      throw new Error('teardown exploded');
    });
    expect(() => {
      claimLaneWriters(projectDir, () => {});
    }).not.toThrow();
  });

  test('release only forgets the current owner', () => {
    const disposed: string[] = [];
    const owner = () => disposed.push('owner');
    claimLaneWriters(projectDir, owner);
    // A stale dispose from an older generation must not clear the registry.
    releaseLaneWriters(projectDir, () => {});
    claimLaneWriters(projectDir, () => {});
    expect(disposed).toEqual(['owner']);
  });
});
