import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import {
  laneIntentsPath,
  readLaneIntents,
  SIDECAR_STALE_AFTER_MS,
  serverInfoPath,
  writeServerInfo,
} from '../../utils/lane-control';
import {
  canonicalDirectory,
  createLaneMirror,
  laneMirrorPath,
} from '../../utils/lane-mirror';
import { SERVER_URL_ENV } from '../../utils/server-url';
import type { LanesDeps } from './commands';
import { runLanesCommand } from './index';
import type { LaneClient, LaneSdkResponse } from './server';

/**
 * All filesystem state lives under a throwaway XDG_DATA_HOME, and no test in
 * this file ever contacts a real server: `createClient` always returns a mock.
 */
let dataHome: string;
let projectDir: string;
let originalDataHome: string | undefined;
let originalServerEnv: string | undefined;

const SERVER_URL = 'http://127.0.0.1:4096/';
const NOW = 1_700_000_000_000;

/**
 * The lane's CURRENT model, in the shape `Session.model` uses at runtime
 * (`{ providerID, id }`). Deliberately not the agent's configured model: every
 * `say` assertion below proves the body carries THIS one, which is what keeps
 * a foreground-fallback failover from being undone (MODEL rule).
 */
const LIVE_MODEL = { providerID: 'anthropic', id: 'claude-fallback-1' };
const PINNED_MODEL = { providerID: 'anthropic', modelID: 'claude-fallback-1' };

beforeEach(() => {
  originalDataHome = process.env.XDG_DATA_HOME;
  originalServerEnv = process.env[SERVER_URL_ENV];
  delete process.env[SERVER_URL_ENV];
  dataHome = mkdtempSync(path.join(os.tmpdir(), 'lanes-cli-'));
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'lanes-project-'));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  if (originalServerEnv === undefined) delete process.env[SERVER_URL_ENV];
  else process.env[SERVER_URL_ENV] = originalServerEnv;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────

interface LaneSeed {
  taskID?: string;
  alias?: string;
  agent?: string;
  parentSessionID?: string;
  state?: 'running' | 'completed' | 'error' | 'cancelled' | 'stopped';
  objective?: string;
  statusUncertain?: boolean;
  cancelledByUser?: string | true;
  /**
   * Mark the run as "a cancellation is in flight".
   *
   * On master only two paths set this: `markCancelled` under a cancellation
   * lease (which also settles the state) and the wall-clock supervisor's
   * `claimWallClockDeadline` (which leaves the lane RUNNING while its abort is
   * in flight). Both are seeded through their real board methods below.
   */
  cancellationRequested?: boolean;
  permissionTool?: string;
  /** Attribute the lane to an ESC cascade confirmed at this instant. */
  cascadeAt?: number;
}

/**
 * Write the mirror through the REAL board + writer path.
 *
 * Hand-rolling the JSON would let a test pass while the production writer
 * emits something the CLI cannot read.
 */
function seedLanes(lanes: LaneSeed[] = [{}], directory = projectDir): void {
  const board = new BackgroundJobBoard();
  for (const [index, lane] of lanes.entries()) {
    const taskID = lane.taskID ?? `ses_child${index + 1}`;
    board.registerLaunch({
      taskID,
      parentSessionID: lane.parentSessionID ?? 'ses_parent',
      agent: lane.agent ?? 'fixer',
      description: lane.objective ?? 'fix the parser',
      objective: lane.objective ?? 'fix the parser',
      background: true,
      now: NOW - 60_000 + index,
    });
    if (lane.permissionTool) {
      board.markAwaitingPermission(taskID, {
        tool: lane.permissionTool,
        permissionID: 'per_1',
        now: NOW - 30_000,
      });
    }
    if (lane.cancellationRequested) {
      const lease = board.acquireCancellationLease(taskID, 1);
      if (lane.state === 'cancelled') {
        board.markCancelled(taskID, 'obsolete', NOW - 2_000, {
          force: true,
          expectedGeneration: 1,
          cancellationLease: lease,
        });
      } else {
        // Running + cancellationRequested: the wall-clock supervisor has
        // requested an abort and it is still in flight.
        board.claimWallClockDeadline({ taskID, generation: 1 });
      }
      if (lease) board.releaseLease(lease);
    }
    switch (lane.state) {
      case undefined:
      case 'running':
        if (lane.statusUncertain) {
          board.markStatusUncertain(taskID, 'busy but silent for 300s');
        }
        break;
      case 'stopped':
        board.markStopped(taskID, 'stopped before a terminal task result');
        break;
      case 'cancelled':
        if (!lane.cancellationRequested) {
          board.updateStatus({
            taskID,
            state: 'cancelled',
            resultSummary: 'cancelled',
          });
        }
        break;
      default:
        board.updateStatus({
          taskID,
          state: lane.state,
          resultSummary:
            lane.state === 'error' ? 'MessageAbortedError' : 'all done',
        });
        break;
    }
    if (lane.cascadeAt !== undefined) {
      board.markCascade(taskID, {
        parentSessionID: lane.parentSessionID ?? 'ses_parent',
        at: lane.cascadeAt,
      });
    }
    if (lane.cancelledByUser) {
      board.markCancelledByUser(
        taskID,
        lane.cancelledByUser === true ? undefined : lane.cancelledByUser,
        NOW - 1_000,
      );
    }
  }
  createLaneMirror({
    directory,
    enabled: true,
    lanes: () => board.list(),
    now: () => NOW - 500,
  }).flushNow();
}

function seedSidecar(
  overrides: Partial<{
    url: string;
    directory: string;
    pid: number;
    updatedAt: number;
  }> = {},
): void {
  writeServerInfo(serverInfoPath(projectDir), {
    url: overrides.url ?? SERVER_URL,
    directory: overrides.directory ?? canonicalDirectory(projectDir),
    pid: overrides.pid ?? process.pid,
    startedAt: NOW - 600_000,
    updatedAt: overrides.updatedAt ?? NOW - 1_000,
  });
}

interface ClientSpec {
  /** Session status map, or a function of the call index. */
  statuses?: Array<Record<string, { type: string }> | undefined>;
  get?: LaneSdkResponse | (() => LaneSdkResponse | Promise<LaneSdkResponse>);
  messages?: LaneSdkResponse;
  abort?: LaneSdkResponse | (() => LaneSdkResponse | Promise<LaneSdkResponse>);
  promptAsync?:
    | LaneSdkResponse
    | (() => LaneSdkResponse | Promise<LaneSdkResponse>);
}

function mockClient(spec: ClientSpec = {}) {
  let statusCall = 0;
  const calls = {
    get: [] as unknown[],
    messages: [] as unknown[],
    abort: [] as unknown[],
    status: [] as unknown[],
    promptAsync: [] as unknown[],
  };
  const resolve = (
    value:
      | LaneSdkResponse
      | (() => LaneSdkResponse | Promise<LaneSdkResponse>)
      | undefined,
    fallback: LaneSdkResponse,
  ) => (typeof value === 'function' ? value() : (value ?? fallback));

  const client: LaneClient = {
    session: {
      get: mock((input: unknown) => {
        calls.get.push(input);
        // The runtime session record carries `model`/`agent` even though the
        // published SDK type omits them (same reason task-message reads them
        // through unknown-shaped access). `say` needs the model to pin it.
        return resolve(spec.get, {
          data: { parentID: 'ses_parent', model: LIVE_MODEL },
        });
      }) as LaneClient['session']['get'],
      messages: mock((input: unknown) => {
        calls.messages.push(input);
        return spec.messages ?? { data: [] };
      }) as LaneClient['session']['messages'],
      abort: mock((input: unknown) => {
        calls.abort.push(input);
        return resolve(spec.abort, { data: true });
      }) as LaneClient['session']['abort'],
      status: mock((input: unknown) => {
        calls.status.push(input);
        const list = spec.statuses ?? [];
        const entry =
          statusCall < list.length ? list[statusCall] : list[list.length - 1];
        statusCall += 1;
        return { data: entry ?? {} };
      }) as LaneClient['session']['status'],
      promptAsync: mock((input: unknown) => {
        calls.promptAsync.push(input);
        return resolve(spec.promptAsync, { data: undefined });
      }) as LaneClient['session']['promptAsync'],
    },
  };
  return { client, calls };
}

function harness(spec: ClientSpec = {}, overrides: Partial<LanesDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { client, calls } = mockClient(spec);
  let now = NOW;
  const deps: LanesDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient: async () => client,
    now: () => now,
    // The stop verification loop polls until the deadline; the clock must
    // advance with the sleep or the loop never terminates.
    sleep: async (ms: number) => {
      now += ms;
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    out,
    err,
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    json: () => JSON.parse(out.join('\n')) as Record<string, unknown>,
  };
}

async function run(
  argv: string[],
  spec?: ClientSpec,
  overrides?: Partial<LanesDeps>,
) {
  const h = harness(spec, overrides);
  const { parseLanesArgs } = await import('./args');
  const code = await runLanesCommand(
    parseLanesArgs([...argv, '--dir', projectDir]),
    h.deps,
  );
  return { ...h, code };
}

// ── list ──────────────────────────────────────────────────────────────

describe('omos lanes list', () => {
  test('explains a missing mirror without failing', async () => {
    const result = await run(['list']);
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('No lane mirror recorded');
    expect(result.stdout()).toContain('backgroundJobs.laneControl');
    expect(result.stdout()).toContain(laneMirrorPath(projectDir));
  });

  test('renders alias, agent, state, objective and session id', async () => {
    seedLanes([{ objective: 'fix the parser' }]);
    const result = await run(['list']);
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('fix-1  fixer  running');
    expect(result.stdout()).toContain('fix the parser');
    expect(result.stdout()).toContain('ses_child1');
  });

  test('surfaces an open permission prompt and the uncertainty reason', async () => {
    seedLanes([{ permissionTool: 'bash', statusUncertain: true }]);
    const result = await run(['list']);
    expect(result.stdout()).toContain('Waiting: permission for bash');
    expect(result.stdout()).toContain('Status: busy but silent');
    expect(result.stdout()).toContain('status uncertain');
  });

  test('labels a lane the user stopped', async () => {
    seedLanes([{ state: 'error', cancelledByUser: 'wrong file set' }]);
    const result = await run(['list']);
    expect(result.stdout()).toContain('stopped by you');
  });

  test('--json exposes the ids and flags a script needs', async () => {
    seedLanes([{ state: 'error', cancelledByUser: 'nope' }]);
    const result = await run(['list', '--json']);
    const payload = result.json();
    expect(payload.exists).toBe(true);
    expect(payload.lanes).toEqual([
      expect.objectContaining({
        alias: 'fix-1',
        sessionID: 'ses_child1',
        parentSessionID: 'ses_parent',
        agent: 'fixer',
        state: 'error',
        statusUncertain: false,
        cancelledByUser: expect.objectContaining({ reason: 'nope' }),
      }),
    ]);
  });

  test('needs no server at all', async () => {
    seedLanes();
    const result = await run(['list']);
    expect(result.calls.status).toHaveLength(0);
    expect(result.calls.get).toHaveLength(0);
  });

  test('reads the same mirror through a symlinked --dir', async () => {
    seedLanes();
    const link = path.join(dataHome, 'linked');
    symlinkSync(projectDir, link);
    const h = harness();
    const { parseLanesArgs } = await import('./args');
    const code = await runLanesCommand(
      parseLanesArgs(['list', '--dir', link]),
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.stdout()).toContain('fix-1');
  });
});

// ── selector resolution ───────────────────────────────────────────────

describe('selector resolution', () => {
  test('an unknown alias lists what is available', async () => {
    seedLanes();
    const result = await run(['show', 'nope-9']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('No lane "nope-9"');
    expect(result.stderr()).toContain('Known lanes: fix-1');
  });

  test('one alias shared by two orchestrators is ambiguous, never guessed', async () => {
    seedLanes([
      { taskID: 'ses_a', parentSessionID: 'ses_parent1' },
      { taskID: 'ses_b', parentSessionID: 'ses_parent2' },
    ]);
    seedSidecar();
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_a: { type: 'busy' } }],
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('matches 2 lanes');
    expect(result.stderr()).toContain('ses_a');
    expect(result.stderr()).toContain('ses_b');
    expect(result.calls.abort).toHaveLength(0);
  });

  test('a raw session id the mirror never saw is still readable', async () => {
    seedSidecar();
    const result = await run(['show', 'ses_unknown'], {
      messages: { data: [] },
    });
    expect(result.code).toBe(0);
    // show is read-only: no parentage round trip.
    expect(result.calls.get).toHaveLength(0);
  });
});

// ── M1: orchestrator-abort refusal ────────────────────────────────────

describe('orchestrator guards (M1)', () => {
  test('stop refuses a known parent session offline, naming its lanes', async () => {
    seedLanes([{ taskID: 'ses_child1' }, { taskID: 'ses_child2' }]);
    seedSidecar();
    const result = await run(['stop', 'ses_parent']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is an orchestrator session');
    expect(result.stderr()).toContain('It owns 2 lanes: fix-1, fix-2');
    expect(result.calls.abort).toHaveLength(0);
    // Refused before the server was ever contacted.
    expect(result.calls.status).toHaveLength(0);
    expect(existsSync(laneIntentsPath(projectDir))).toBe(false);
  });

  test('say refuses a raw top-level id (no parentID)', async () => {
    seedSidecar();
    const result = await run(['say', 'ses_top', 'hello'], {
      get: { data: { parentID: undefined } },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is a top-level session');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('an unverifiable raw id fails closed', async () => {
    seedSidecar();
    const result = await run(['stop', 'ses_mystery'], {
      get: () => {
        throw new Error('fetch failed');
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('Cannot reach the OpenCode server');
    expect(result.calls.abort).toHaveLength(0);
  });

  test('a 404 on a raw id says so instead of aborting', async () => {
    seedSidecar();
    const result = await run(['stop', 'ses_gone'], {
      get: { error: { message: 'not found' }, response: { status: 404 } },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('does not exist');
    expect(result.calls.abort).toHaveLength(0);
  });

  test('--force proceeds but announces the blast radius', async () => {
    seedLanes([{ taskID: 'ses_child1' }, { taskID: 'ses_child2' }]);
    seedSidecar();
    const result = await run(['stop', 'ses_parent', '--force'], {
      statuses: [{ ses_parent: { type: 'busy' } }, {}],
    });
    expect(result.stderr()).toContain('Forcing: ses_parent is an orchestrator');
    expect(result.stderr()).toContain('kills 2 lanes (fix-1, fix-2)');
    expect(result.calls.abort).toHaveLength(1);
    expect(result.code).toBe(0);
  });

  test('--force on an unknown top-level id still warns', async () => {
    seedSidecar();
    const result = await run(['stop', 'ses_top', '--force'], {
      get: { data: {} },
      statuses: [{ ses_top: { type: 'busy' } }, {}],
    });
    expect(result.stderr()).toContain('is a top-level session');
    expect(result.calls.abort).toHaveLength(1);
  });

  test('a verified child raw id is accepted', async () => {
    seedSidecar();
    const result = await run(['stop', 'ses_child9'], {
      get: { data: { parentID: 'ses_parent' } },
      statuses: [{ ses_child9: { type: 'busy' } }, {}],
    });
    expect(result.code).toBe(0);
    expect(result.calls.abort).toHaveLength(1);
  });
});

// ── show ──────────────────────────────────────────────────────────────

describe('omos lanes show', () => {
  const messages = {
    data: [
      {
        info: { role: 'user', agent: 'orchestrator' },
        parts: [{ type: 'text', text: 'do the thing' }],
      },
      {
        info: { role: 'assistant', agent: 'fixer', finish: 'stop' },
        parts: [
          { type: 'tool', tool: 'edit', state: { status: 'completed' } },
          { type: 'text', text: 'done the thing' },
        ],
      },
    ],
  };

  test('prints the tail with roles, tools and text', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['show', 'fix-1'], { messages });
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('fix-1 / fixer / running');
    expect(result.stdout()).toContain('Showing 2 of 2 messages');
    expect(result.stdout()).toContain('· edit — completed');
    expect(result.stdout()).toContain('done the thing');
  });

  test('-n limits the tail', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['show', 'fix-1', '-n', '1'], { messages });
    expect(result.stdout()).toContain('Showing 1 of 2 messages');
    expect(result.stdout()).not.toContain('do the thing');
  });

  test('--json summarizes each message', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['show', 'fix-1', '--json'], { messages });
    const payload = result.json();
    expect(payload).toMatchObject({
      sessionID: 'ses_child1',
      alias: 'fix-1',
      agent: 'fixer',
      totalMessages: 2,
    });
  });

  test('a deleted session is reported, not thrown', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['show', 'fix-1'], {
      messages: { error: { message: 'gone' }, response: { status: 404 } },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('does not exist');
  });
});

// ── S2: stop ──────────────────────────────────────────────────────────

describe('omos lanes stop', () => {
  test('records the intent BEFORE aborting, then verifies idle', async () => {
    seedLanes();
    seedSidecar();
    const order: string[] = [];
    const result = await run(
      ['stop', 'fix-1', '--reason', 'wrong file set'],
      {
        statuses: [{ ses_child1: { type: 'busy' } }, {}],
        abort: () => {
          order.push('abort');
          return { data: true };
        },
      },
      {
        intentsFile: laneIntentsPath(projectDir),
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('Stopped fix-1 (fixer)');
    expect(result.stdout()).toContain('your cancellation');
    const intents = readLaneIntents(laneIntentsPath(projectDir), { now: NOW });
    expect(intents).toEqual([
      {
        at: NOW,
        action: 'stop',
        sessionID: 'ses_child1',
        reason: 'wrong file set',
      },
    ]);
    expect(order).toEqual(['abort']);
  });

  test('refuses an idle lane and writes NO intent', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1'], { statuses: [{}] });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is not active');
    expect(result.stderr()).toContain('nothing to stop');
    expect(result.calls.abort).toHaveLength(0);
    expect(existsSync(laneIntentsPath(projectDir))).toBe(false);
  });

  test('refuses when the status could not be read (wrong server risk)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'weird' } }],
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('status could not be read');
    expect(result.calls.abort).toHaveLength(0);
    expect(existsSync(laneIntentsPath(projectDir))).toBe(false);
  });

  test('an already-stopped lane that the server confirms idle records the cancel', async () => {
    seedLanes([{ state: 'stopped' }]);
    seedSidecar();
    const result = await run(['stop', 'fix-1', '--reason', 'stay dead'], {
      statuses: [{}],
    });
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('was already stopped');
    expect(result.stdout()).toContain('Recorded as your cancellation');
    expect(result.stdout()).toContain('task_revive');
    expect(result.calls.abort).toHaveLength(0);
    expect(
      readLaneIntents(laneIntentsPath(projectDir), { now: NOW })[0]?.reason,
    ).toBe('stay dead');
  });

  test('an errored (aborted) lane counts as already stopped', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();
    const result = await run(['stop', 'fix-1'], { statuses: [{}] });
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('was already stopped');
  });

  test('a stale mirror cannot turn a live lane into a no-op', async () => {
    seedLanes([{ state: 'stopped' }]);
    seedSidecar();
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'busy' } }, {}],
    });
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('Stopped fix-1');
    expect(result.calls.abort).toHaveLength(1);
  });

  test('an unverified idle exits 1 even though the abort was accepted', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      abort: { data: true },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('still "busy"');
    expect(result.calls.abort).toHaveLength(1);
  });

  test('a forced stop of a lane inactive here does not claim success (S6)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1', '--force'], {
      // Idle before AND after: indistinguishable from an untouched session.
      statuses: [{}],
    });
    expect(result.calls.abort).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.stdout()).not.toContain('Stopped fix-1');
    expect(result.stderr()).toContain(`Abort sent to ${SERVER_URL}`);
    expect(result.stderr()).toContain('did not report the lane');
    expect(result.stderr()).toContain('nothing may have');
    expect(result.stderr()).toContain('--server');
  });

  test('a forced stop reports the inactive outcome in --json too', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1', '--force', '--json'], {
      statuses: [{}],
    });
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({
      aborted: true,
      forced: true,
      activeBefore: false,
      verified: false,
      status: 'idle',
    });
  });

  test('--json reports what happened', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1', '--json'], {
      statuses: [{ ses_child1: { type: 'busy' } }, {}],
    });
    expect(result.json()).toMatchObject({
      action: 'stop',
      sessionID: 'ses_child1',
      alias: 'fix-1',
      aborted: true,
      verified: true,
      status: 'idle',
      intentRecorded: true,
    });
  });

  test('--json refusal is machine-readable and exits 1', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1', '--json'], { statuses: [{}] });
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({
      aborted: false,
      verified: false,
      status: 'idle',
      error: 'lane is not active',
    });
  });

  test('a 404 on abort is reported instead of claiming success', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      abort: { error: { message: 'gone' }, response: { status: 404 } },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('does not exist');
  });
});

// ── S3: say ───────────────────────────────────────────────────────────

describe('omos lanes say', () => {
  test('queues the text with the lane own agent and live model (A2 + MODEL)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'also update the codemap'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
    });
    expect(result.code).toBe(0);
    expect(result.calls.promptAsync[0]).toEqual({
      path: { id: 'ses_child1' },
      query: { directory: projectDir },
      body: {
        agent: 'fixer',
        model: PINNED_MODEL,
        parts: [{ type: 'text', text: 'also update the codemap' }],
      },
    });
    expect(result.stdout()).toContain('Queued for fix-1 (fixer)');
    // No intent line: only stop needs one.
    expect(existsSync(laneIntentsPath(projectDir))).toBe(false);
  });

  test('pins the SESSION model, not whatever the agent is configured with', async () => {
    // The failover case: core resolves `input.model ?? agent.model ??
    // currentModel(session)`, so an agent-only body would move this lane back
    // onto the agent's configured primary.
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'keep going'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      get: {
        data: {
          parentID: 'ses_parent',
          model: { providerID: 'openai', id: 'gpt-fallback-2' },
          variant: 'thinking',
        },
      },
    });
    expect(result.code).toBe(0);
    expect(
      (result.calls.promptAsync[0] as { body: Record<string, unknown> }).body,
    ).toEqual({
      agent: 'fixer',
      model: { providerID: 'openai', modelID: 'gpt-fallback-2' },
      variant: 'thinking',
      parts: [{ type: 'text', text: 'keep going' }],
    });
  });

  test('accepts the promptAsync-style model shape too', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hi'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      get: {
        data: {
          parentID: 'ses_parent',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
      },
    });
    expect(
      (result.calls.promptAsync[0] as { body: { model?: unknown } }).body.model,
    ).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('falls back to the newest USER message model when the session omits it', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hi'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      get: { data: { parentID: 'ses_parent' } },
      messages: {
        data: [
          {
            info: {
              role: 'user',
              model: { providerID: 'anthropic', modelID: 'old-model' },
            },
          },
          {
            info: {
              role: 'assistant',
              model: { providerID: 'anthropic', modelID: 'assistant-model' },
            },
          },
          {
            info: {
              role: 'user',
              model: { providerID: 'anthropic', modelID: 'newest-model' },
              variant: 'default',
            },
          },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(
      (result.calls.promptAsync[0] as { body: { model?: unknown } }).body.model,
    ).toEqual({ providerID: 'anthropic', modelID: 'newest-model' });
  });

  test('refuses when no model can be established (task_message rule)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hi'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      get: { data: { parentID: 'ses_parent' } },
      messages: { data: [] },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('current model could not be established');
    expect(result.stderr()).toContain('CONFIGURED model');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('--force sends without a model pin, and says so', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hi', '--force'], {
      get: { error: { message: 'boom' } },
      messages: { error: { message: 'boom' } },
    });
    expect(result.code).toBe(0);
    expect(result.stderr()).toContain('could not be pinned');
    expect(
      (result.calls.promptAsync[0] as { body: { model?: unknown } }).body.model,
    ).toBeUndefined();
  });

  test('refuses a running lane whose cancellation the orchestrator owns', async () => {
    seedLanes([{ cancellationRequested: true }]);
    seedSidecar();
    for (const argv of [
      ['say', 'fix-1', 'hi'],
      ['say', 'fix-1', 'hi', '--force'],
    ]) {
      const result = await run(argv, {
        statuses: [{ ses_child1: { type: 'busy' } }],
      });
      expect(result.code).toBe(1);
      expect(result.stderr()).toContain('is cancelling it right now');
      expect(result.calls.promptAsync).toHaveLength(0);
    }
  });

  test('refuses without a recorded agent, even with --force', async () => {
    seedSidecar();
    const result = await run(['say', 'ses_child9', 'hello', '--force'], {
      get: { data: { parentID: 'ses_parent' } },
      statuses: [{ ses_child9: { type: 'busy' } }],
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('agent is unknown');
    expect(result.stderr()).toContain('probe A2');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('refuses a running lane that is NOT busy on this server (corruption class)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello'], { statuses: [{}] });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is not active on');
    expect(result.stderr()).toContain('second, concurrent turn');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('a status-uncertain running lane is warned about, not refused', async () => {
    seedLanes([{ statusUncertain: true }]);
    seedSidecar();
    const result = await run(['say', 'fix-1', 'still there?'], {
      statuses: [{}],
    });
    expect(result.code).toBe(0);
    expect(result.stderr()).toContain('status-uncertain');
    expect(result.calls.promptAsync).toHaveLength(1);
  });

  test('a stopped lane needs --force and hears about task_revive', async () => {
    seedLanes([{ state: 'stopped' }]);
    seedSidecar();
    const refused = await run(['say', 'fix-1', 'hello'], { statuses: [{}] });
    expect(refused.code).toBe(1);
    expect(refused.stderr()).toContain('Refusing to message fix-1');
    expect(refused.stderr()).toContain('will not reach the orchestrator');
    expect(refused.stderr()).toContain('task_revive');
    expect(refused.calls.promptAsync).toHaveLength(0);

    const forced = await run(['say', 'fix-1', 'hello', '--force'], {
      statuses: [{}],
    });
    expect(forced.code).toBe(0);
    // S5: a note, not a turn — the lane is not running, so nothing is started.
    expect(
      (forced.calls.promptAsync[0] as { body: Record<string, unknown> }).body,
    ).toEqual({
      agent: 'fixer',
      model: PINNED_MODEL,
      noReply: true,
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(forced.stdout()).toContain("Noted in fix-1 (fixer)'s transcript");
    expect(forced.stdout()).toContain('nothing was started');
  });

  test('a running lane is never sent noReply (it must act on the text)', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
    });
    expect(
      (result.calls.promptAsync[0] as { body: { noReply?: unknown } }).body
        .noReply,
    ).toBeUndefined();
  });

  test('a terminal lane the orchestrator cancelled is forceable as a note', async () => {
    seedLanes([{ state: 'cancelled', cancellationRequested: true }]);
    seedSidecar();
    const result = await run(['say', 'fix-1', 'context for later', '--force'], {
      statuses: [{}],
    });
    expect(result.code).toBe(0);
    expect(
      (result.calls.promptAsync[0] as { body: { noReply?: unknown } }).body
        .noReply,
    ).toBe(true);
  });

  test('a lane the user stopped says so in the refusal', async () => {
    seedLanes([{ state: 'error', cancelledByUser: true }]);
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello'], { statuses: [{}] });
    expect(result.stderr()).toContain('you stopped this lane');
  });

  test('a finished lane needs --force and gets no revive advice', async () => {
    seedLanes([{ state: 'completed' }]);
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello'], { statuses: [{}] });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('already finished (completed)');
    expect(result.stderr()).not.toContain('task_revive');
  });

  test('--force skips the liveness check entirely', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello', '--force'], {
      statuses: [{}],
    });
    expect(result.code).toBe(0);
    expect(result.calls.status).toHaveLength(0);
    expect(result.calls.promptAsync).toHaveLength(1);
  });

  test('a rejected prompt is reported, not swallowed', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hello'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
      promptAsync: { error: { message: 'bad request' } },
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('Server rejected the request');
  });

  test('--json reports the queued message', async () => {
    seedLanes();
    seedSidecar();
    const result = await run(['say', 'fix-1', 'hi', '--json'], {
      statuses: [{ ses_child1: { type: 'retry' } }],
    });
    expect(result.json()).toMatchObject({
      action: 'say',
      alias: 'fix-1',
      agent: 'fixer',
      model: PINNED_MODEL,
      modelPinned: true,
      noReply: false,
      queued: true,
      text: 'hi',
    });
  });
});

// ── S1: server discovery ──────────────────────────────────────────────

describe('server discovery (S1)', () => {
  test('a missing sidecar explains every way to fix it', async () => {
    seedLanes();
    const result = await run(['stop', 'fix-1']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('No OpenCode server recorded');
    expect(result.stderr()).toContain('--server');
    expect(result.stderr()).toContain('OMO_OPENCODE_SERVER_URL');
  });

  test('a dead pid is stale, not a server to talk to', async () => {
    seedLanes();
    seedSidecar({ pid: 999_999_999 });
    const result = await run(['stop', 'fix-1'], undefined, {
      isProcessAlive: () => false,
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is stale');
    expect(result.stderr()).toContain('is not running');
  });

  test('a cold heartbeat is stale even when the pid is alive', async () => {
    seedLanes();
    seedSidecar({ updatedAt: NOW - SIDECAR_STALE_AFTER_MS - 1 });
    const result = await run(['stop', 'fix-1'], undefined, {
      isProcessAlive: () => true,
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('has not been refreshed');
  });

  test('a sidecar for a different project is a hard refusal', async () => {
    seedLanes();
    seedSidecar({ directory: path.join(os.tmpdir(), 'some-other-project') });
    const result = await run(['stop', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
    });
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('belongs to a different project');
    expect(result.calls.abort).toHaveLength(0);
  });

  test('the environment is used when there is no sidecar', async () => {
    seedLanes();
    const result = await run(
      ['say', 'fix-1', 'hello'],
      { statuses: [{ ses_child1: { type: 'busy' } }] },
      { env: { [SERVER_URL_ENV]: SERVER_URL } },
    );
    expect(result.code).toBe(0);
    expect(result.calls.promptAsync).toHaveLength(1);
  });

  test('--server overrides a stale sidecar', async () => {
    seedLanes();
    seedSidecar({ pid: 999_999_999 });
    const h = harness(
      { statuses: [{ ses_child1: { type: 'busy' } }] },
      { isProcessAlive: () => false },
    );
    const { parseLanesArgs } = await import('./args');
    const code = await runLanesCommand(
      parseLanesArgs([
        'say',
        'fix-1',
        'hello',
        '--server',
        'http://127.0.0.1:5555',
        '--dir',
        projectDir,
      ]),
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.calls.promptAsync).toHaveLength(1);
  });

  test('a bogus --server is rejected before any call', async () => {
    seedLanes();
    const h = harness();
    const { parseLanesArgs } = await import('./args');
    const code = await runLanesCommand(
      parseLanesArgs([
        'stop',
        'fix-1',
        '--server',
        'ws://127.0.0.1:4096',
        '--dir',
        projectDir,
      ]),
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.stderr()).toContain('is not an http(s) URL');
  });
});

// ── entry point ───────────────────────────────────────────────────────

describe('runLanesCommand', () => {
  test('help and parse errors are reported without a stack trace', async () => {
    const help = harness();
    expect(await runLanesCommand({ command: 'help' }, help.deps)).toBe(0);
    expect(help.stdout()).toContain('Usage: omos lanes');

    const bad = harness();
    expect(
      await runLanesCommand({ command: 'error', message: 'nope' }, bad.deps),
    ).toBe(1);
    expect(bad.stderr()).toContain('nope');
    expect(bad.stderr()).toContain('omos lanes --help');
  });

  test('an unexpected throw becomes one line and exit 1', async () => {
    seedLanes();
    seedSidecar();
    const h = harness();
    const code = await runLanesCommand(
      {
        command: 'show',
        selector: 'fix-1',
        count: 5,
        dir: projectDir,
        json: false,
        force: false,
      },
      {
        ...h.deps,
        createClient: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(code).toBe(1);
    expect(h.stderr()).toContain('boom');
  });
});

// ── revive ────────────────────────────────────────────────────────────

describe('omos lanes revive', () => {
  const RESUME_START = 'You were interrupted by an abort.';

  function reviveIntents(): ReturnType<typeof readLaneIntents> {
    return readLaneIntents(laneIntentsPath(projectDir), { now: NOW }).filter(
      (intent) => intent.action === 'revive',
    );
  }

  test('resumes an interrupted lane with its own agent AND model pinned', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const result = await run(['revive', 'fix-1']);

    expect(result.code).toBe(0);
    const body = (
      result.calls.promptAsync[0] as { body: Record<string, unknown> }
    ).body;
    // A2: without the agent the server rewrites the session to `build`.
    expect(body.agent).toBe('fixer');
    // MODEL rule: without it, core resolves the AGENT's configured model and
    // silently undoes a foreground-fallback failover.
    expect(body.model).toEqual(PINNED_MODEL);
    expect(body.parts).toEqual([
      { type: 'text', text: expect.stringContaining(RESUME_START) },
    ]);
    // The intent is what lets the plugin register the new run with the
    // revived-run tracker, so the orchestrator is told when it finishes.
    expect(reviveIntents()).toMatchObject([
      { action: 'revive', sessionID: 'ses_child1' },
    ]);
    expect(result.stdout()).toContain('Revived 1 lane');
  });

  test('refuses a busy lane even with --force, and prompts nothing', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const result = await run(['revive', 'fix-1', '--force'], {
      statuses: [{ ses_child1: { type: 'busy' } }],
    });

    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('not idle');
    expect(result.stderr()).toContain('not overridable');
    expect(result.calls.promptAsync).toHaveLength(0);
    expect(reviveIntents()).toHaveLength(0);
  });

  test('refuses a lane that was never interrupted, unless forced', async () => {
    seedLanes([{ state: 'running' }]);
    seedSidecar();

    const refused = await run(['revive', 'fix-1']);
    expect(refused.code).toBe(1);
    expect(refused.stderr()).toContain('Refusing to revive fix-1');
    expect(refused.calls.promptAsync).toHaveLength(0);
  });

  test('refuses a lane that finished: the resume prompt would be a lie', async () => {
    seedLanes([{ state: 'completed' }]);
    seedSidecar();

    const result = await run(['revive', 'fix-1']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('it finished normally');
    expect(result.stderr()).toContain('task_revive');
  });

  test('an acknowledged (reconciled) ESC death is still revivable', async () => {
    // The orchestrator taking one turn moves the record from `error` to
    // `reconciled` - it is the same interrupted lane, and --cascade must not
    // quietly stop finding it.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      description: 'fix the parser',
      background: true,
      now: NOW - 60_000,
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'error' });
    board.markCascade('ses_child1', {
      parentSessionID: 'ses_parent',
      at: NOW - 10_000,
    });
    board.markReconciled('ses_child1');
    createLaneMirror({
      directory: projectDir,
      enabled: true,
      lanes: () => board.list(),
      now: () => NOW - 500,
    }).flushNow();
    seedSidecar();

    const result = await run(['revive', '--cascade', '--json']);
    expect(
      (result.json() as { revived: Array<{ sessionID: string }> }).revived,
    ).toHaveLength(1);
  });

  test('an unreadable status is not prompted blind, but --force may', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const blind = await run(['revive', 'fix-1'], {
      statuses: [{ ses_child1: { type: 'weird-shape' } } as never],
    });
    expect(blind.code).toBe(1);
    expect(blind.stderr()).toContain('not prompting blind');

    const forced = await run(['revive', 'fix-1', '--force'], {
      statuses: [{ ses_child1: { type: 'weird-shape' } } as never],
    });
    expect(forced.code).toBe(0);
    expect(forced.calls.promptAsync).toHaveLength(1);
  });

  test('--cascade takes the LATEST group only', async () => {
    seedLanes([
      { state: 'error', cascadeAt: NOW - 500_000 },
      { state: 'error', cascadeAt: NOW - 10_000, agent: 'explorer' },
      { state: 'error', cascadeAt: NOW - 10_000, agent: 'oracle' },
      { state: 'error' },
    ]);
    seedSidecar();

    const result = await run(['revive', '--cascade', '--json']);

    const payload = result.json() as {
      revived: Array<{ sessionID: string }>;
      scope: string;
    };
    expect(payload.scope).toBe('cascade');
    expect(payload.revived.map((entry) => entry.sessionID)).toEqual([
      'ses_child2',
      'ses_child3',
    ]);
  });

  test('--cascade says so when nothing is attributed to an ESC', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const result = await run(['revive', '--cascade']);
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('none is attributed to an ESC cascade');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('a lane you stopped yourself is excluded from --all but revivable by name', async () => {
    seedLanes([
      { state: 'error', cancelledByUser: 'I meant it' },
      { state: 'error', agent: 'explorer' },
    ]);
    seedSidecar();

    const bulk = await run(['revive', '--all', '--json']);
    expect(
      (bulk.json() as { revived: Array<{ sessionID: string }> }).revived.map(
        (entry) => entry.sessionID,
      ),
    ).toEqual(['ses_child2']);

    const named = await run(['revive', 'fix-1']);
    expect(named.code).toBe(0);
    expect(named.calls.promptAsync).toHaveLength(1);
  });

  test('a session that no longer exists is reported, not retried', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const result = await run(['revive', 'fix-1'], {
      promptAsync: () => ({
        error: { message: 'not found' },
        response: { status: 404 } as Response,
      }),
    });

    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('session no longer exists');
    expect(result.stderr()).toContain('relaunch the task instead');
  });

  test('refuses an orchestrator session id, which would kill every lane', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const result = await run(['revive', 'ses_parent']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain('is an orchestrator session');
    expect(result.calls.promptAsync).toHaveLength(0);
  });

  test('refuses to resume unpinned when the model cannot be established', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const spec = { get: { data: { parentID: 'ses_parent' } } } as ClientSpec;
    const refused = await run(['revive', 'fix-1'], spec);
    expect(refused.code).toBe(1);
    expect(refused.stderr()).toContain(
      'current model could not be established',
    );
    expect(refused.calls.promptAsync).toHaveLength(0);

    const forced = await run(['revive', 'fix-1', '--force'], spec);
    expect(forced.code).toBe(0);
    const body = (
      forced.calls.promptAsync[0] as { body: Record<string, unknown> }
    ).body;
    expect(body.model).toBeUndefined();
    expect(body.agent).toBe('fixer');
  });

  /**
   * `--force` is an override, not an absolution. A forced resume that reports a
   * bare "Revived 1 lane" hides exactly the facts the user needs to judge it,
   * and `say` already sets the precedent of naming every waiver out loud.
   */
  test('a forced resume names what it overrode, in the report and in --json', async () => {
    seedLanes([{ state: 'error' }]);
    seedSidecar();

    const forced = await run(['revive', 'fix-1', '--force'], {
      // Unreadable status AND an unpinnable model: both waivers at once.
      statuses: [{ ses_child1: { type: 'weird-shape' } } as never],
      get: { data: { parentID: 'ses_parent' } },
    });

    expect(forced.code).toBe(0);
    expect(forced.stderr()).toContain('this resume is blind');
    expect(forced.stderr()).toContain('model could not be pinned');
    expect(forced.stdout()).toContain('note: status was unreadable');
    expect(forced.stdout()).toContain('note: model could not be pinned');

    const asJson = await run(['revive', 'fix-1', '--force', '--json'], {
      statuses: [{ ses_child1: { type: 'weird-shape' } } as never],
      get: { data: { parentID: 'ses_parent' } },
    });
    const payload = asJson.json() as {
      revived: Array<{ modelPinned: boolean; notes: string[] }>;
    };
    expect(payload.revived[0]?.modelPinned).toBe(false);
    expect(payload.revived[0]?.notes).toHaveLength(2);
  });

  test('forcing past a board-state refusal says what it overrode', async () => {
    seedLanes([{ state: 'completed' }]);
    seedSidecar();

    const forced = await run(['revive', 'fix-1', '--force']);

    expect(forced.code).toBe(0);
    expect(forced.stderr()).toContain('Forcing fix-1');
    expect(forced.stderr()).toContain('it finished normally');
    expect(forced.calls.promptAsync).toHaveLength(1);
  });
});
