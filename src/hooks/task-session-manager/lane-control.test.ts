/**
 * Plugin side of `omos lanes`: the permission (HITL) stamp for child lanes, the
 * user-stop attribution on an abort, and the mirror/sidecar/intent wiring in
 * the task-session-manager hook.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import {
  appendLaneIntent,
  laneIntentsPath,
  readLaneIntents,
  readServerInfo,
  serverInfoPath,
} from '../../utils/lane-control';
import { laneMirrorPath, readLaneMirror } from '../../utils/lane-mirror';
import { SERVER_URL_ENV } from '../../utils/server-url';
import { handleEvent } from './event-router';
import { createTaskSessionManagerHook } from './index';

const ABORT_ERROR = { name: 'MessageAbortedError', message: 'aborted' };

function createDeps(
  board: BackgroundJobBoard,
  overrides: {
    now?: () => number;
    shouldManageSession?: (sessionID: string) => boolean;
    claimUserStopIntent?: (
      sessionID: string,
    ) => { reason?: string } | undefined;
  } = {},
) {
  return {
    inputWaits: {
      trackInputWait: mock(() => {}),
      clearInputWaits: mock(() => {}),
      waitsByParent: new Map<string, Set<string | symbol>>(),
    },
    idleSessionTokens: {
      clearSession: mock(() => {}),
      invalidate: mock(() => {}),
      disposeLocalState: mock(() => {}),
      sessionTokens: new Map<string, symbol>(),
    },
    options: {
      // Children are NOT managed sessions; only the orchestrator is.
      shouldManageSession:
        overrides.shouldManageSession ??
        ((sessionID: string) => sessionID === 'parent-1'),
      now: overrides.now ?? (() => 10_000),
    },
    idleReconciler: {
      scheduleIdleReconciliation: mock(() => {}),
      scheduleChildIdleReconciliation: mock(() => {}),
      scheduleErrorTerminalize: mock(() => {}),
      clearIdleTimers: mock(() => {}),
      clearAllTimers: mock(() => []),
    },
    deferredInlineErrors: new Set<string>(),
    backgroundJobBoard: board,
    pendingCallTracker: {
      peekByParentAndAgent: mock(() => undefined),
      clearSession: mock(() => {}),
    },
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      clearSession: mock(() => {}),
      prune: mock(() => {}),
    },
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    retainedBoardSnapshots: new Map(),
    revivedRunTracker: { onTerminal: mock(() => {}), dispose: mock(() => {}) },
    ...(overrides.claimUserStopIntent
      ? { claimUserStopIntent: mock(overrides.claimUserStopIntent) }
      : {}),
  };
}

async function route(
  deps: ReturnType<typeof createDeps>,
  type: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await handleEvent({ event: { type, properties } } as never, deps as never);
}

function runningBoard(): BackgroundJobBoard {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'fix the parser',
    background: true,
    now: 1_000,
  });
  return board;
}

describe('permission stamp for child lanes', () => {
  test('the in-process CORE ask shape stamps the tool (permission.asked)', async () => {
    // This is what a plugin actually receives: core's own event bus payload,
    // where the tool is `permission`, not `type`. Getting this wrong makes the
    // whole stamp dead code.
    const board = runningBoard();
    await route(createDeps(board), 'permission.asked', {
      id: 'per_1',
      sessionID: 'child-1',
      permission: 'bash',
      patterns: ['rm *'],
      metadata: {},
      always: [],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    });

    expect(board.get('child-1')?.awaitingPermission).toEqual({
      tool: 'bash',
      at: 10_000,
      permissionID: 'per_1',
    });
  });

  test('the CORE reply shape clears it (requestID, not permissionID)', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.asked', {
      id: 'per_1',
      sessionID: 'child-1',
      permission: 'bash',
    });
    await route(deps, 'permission.replied', {
      sessionID: 'child-1',
      requestID: 'per_1',
      reply: 'once',
    });
    expect(board.get('child-1')?.awaitingPermission).toBeUndefined();
  });

  test('a CORE reply to a superseded prompt leaves the stamp alone', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.asked', {
      id: 'per_2',
      sessionID: 'child-1',
      permission: 'edit',
    });
    await route(deps, 'permission.replied', {
      sessionID: 'child-1',
      requestID: 'per_1',
      reply: 'reject',
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toBe('edit');
  });

  test('permission.updated stamps the tool the lane is blocked on', async () => {
    const board = runningBoard();
    await route(createDeps(board), 'permission.updated', {
      id: 'per_1',
      type: 'bash',
      title: 'Run `rm -rf build`',
      sessionID: 'child-1',
      messageID: 'msg_1',
    });

    expect(board.get('child-1')?.awaitingPermission).toEqual({
      tool: 'bash',
      at: 10_000,
      permissionID: 'per_1',
    });
  });

  test('permission.asked is accepted too (host-version tolerance)', async () => {
    const board = runningBoard();
    await route(createDeps(board), 'permission.asked', {
      id: 'per_1',
      type: 'edit',
      sessionID: 'child-1',
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toBe('edit');
  });

  test('the title names the tool when neither permission nor type does', async () => {
    const board = runningBoard();
    await route(createDeps(board), 'permission.updated', {
      id: 'per_1',
      title: 'Allow the network fetch?',
      sessionID: 'child-1',
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toBe(
      'Allow the network fetch?',
    );
  });

  test('an identifier-shaped candidate wins over a sentence', async () => {
    const board = runningBoard();
    await route(createDeps(board), 'permission.asked', {
      id: 'per_1',
      sessionID: 'child-1',
      permission: 'webfetch',
      title: 'Allow the network fetch?',
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toBe('webfetch');
  });

  test('a long sentence is truncated before it reaches the board', async () => {
    const board = runningBoard();
    await route(createDeps(board), 'permission.updated', {
      id: 'per_1',
      sessionID: 'child-1',
      title: 'x'.repeat(400),
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toHaveLength(60);
  });

  test('permission.replied clears it', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.updated', {
      id: 'per_1',
      type: 'bash',
      sessionID: 'child-1',
    });
    await route(deps, 'permission.replied', {
      sessionID: 'child-1',
      permissionID: 'per_1',
      response: 'once',
    });
    expect(board.get('child-1')?.awaitingPermission).toBeUndefined();
  });

  test('a reply for another prompt leaves the current stamp alone', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.updated', {
      id: 'per_2',
      type: 'bash',
      sessionID: 'child-1',
    });
    await route(deps, 'permission.replied', {
      sessionID: 'child-1',
      permissionID: 'per_1',
    });
    expect(board.get('child-1')?.awaitingPermission?.tool).toBe('bash');
  });

  test('events for unknown sessions and missing ids are no-ops', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.updated', {
      id: 'per_1',
      type: 'bash',
      sessionID: 'child-unknown',
    });
    await route(deps, 'permission.updated', { id: 'per_1', type: 'bash' });
    await route(deps, 'permission.updated', { sessionID: 'child-1' });
    expect(board.get('child-1')?.awaitingPermission).toBeUndefined();
    expect(board.get('child-unknown')).toBeUndefined();
  });

  test('lane output clears a stamp whose reply was missed', async () => {
    const board = runningBoard();
    const deps = createDeps(board, { now: () => 20_000 });
    await route(deps, 'permission.updated', {
      id: 'per_1',
      type: 'bash',
      sessionID: 'child-1',
    });
    await route(deps, 'message.part.delta', {
      sessionID: 'child-1',
      messageID: 'msg_2',
    });
    expect(board.get('child-1')?.awaitingPermission).toBeUndefined();
    expect(board.get('child-1')?.lastActivityAt).toBe(20_000);
  });

  test('the upstream input-wait tracker still sees every permission event', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'permission.updated', {
      id: 'per_1',
      type: 'bash',
      sessionID: 'parent-1',
    });
    expect(deps.inputWaits.trackInputWait).toHaveBeenCalled();
  });
});

describe('user-stop attribution on abort', () => {
  test('a claimed stop intent labels the error record', async () => {
    const board = runningBoard();
    const deps = createDeps(board, {
      claimUserStopIntent: () => ({ reason: 'wrong file set' }),
    });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: ABORT_ERROR,
    });

    const record = board.get('child-1');
    expect(record?.state).toBe('error');
    expect(record?.cancelledByUser).toMatchObject({ reason: 'wrong file set' });
    // Still revivable in place: the state is untouched by the label.
    expect(record?.statusUncertain).toBe(false);
    expect(deps.revivedRunTracker.onTerminal).toHaveBeenCalled();
  });

  test('no intent means an anonymous abort, and the file is only read once', async () => {
    const board = runningBoard();
    const claim = mock(() => undefined);
    const deps = createDeps(board, { claimUserStopIntent: claim });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: ABORT_ERROR,
    });
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  test('a non-abort error never consults the intents file', async () => {
    const board = runningBoard();
    const claim = mock(() => ({ reason: 'should not be read' }));
    const deps = createDeps(board, { claimUserStopIntent: claim });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: { name: 'ProviderAuthError', message: 'boom' },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
  });

  test('an orchestrator-owned cancellation is not relabelled', async () => {
    const board = runningBoard();
    const lease = board.acquireCancellationLease('child-1', 1);
    board.markCancelled('child-1', 'obsolete', 2_000, {
      force: true,
      expectedGeneration: 1,
      cancellationLease: lease,
    });
    board.releaseLease(lease as NonNullable<typeof lease>);

    const deps = createDeps(board, {
      claimUserStopIntent: () => ({ reason: 'mine' }),
    });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: ABORT_ERROR,
    });
    expect(board.get('child-1')?.state).toBe('cancelled');
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
  });

  test('lane control off means no claim function at all', async () => {
    const board = runningBoard();
    const deps = createDeps(board);
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: ABORT_ERROR,
    });
    expect(board.get('child-1')?.state).toBe('error');
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
  });
});

describe('task-session-manager lane-control wiring', () => {
  let dataHome: string;
  let projectDir: string;
  let originalDataHome: string | undefined;
  let originalServerEnv: string | undefined;

  beforeEach(() => {
    originalDataHome = process.env.XDG_DATA_HOME;
    originalServerEnv = process.env[SERVER_URL_ENV];
    dataHome = mkdtempSync(path.join(os.tmpdir(), 'lane-wiring-data-'));
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'lane-wiring-project-'));
    process.env.XDG_DATA_HOME = dataHome;
    process.env[SERVER_URL_ENV] = 'http://127.0.0.1:4096';
  });

  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalServerEnv === undefined) delete process.env[SERVER_URL_ENV];
    else process.env[SERVER_URL_ENV] = originalServerEnv;
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function createHook(
    laneControl: boolean,
    board: BackgroundJobBoard,
    overrides: {
      client?: unknown;
      revivedRunTracker?: unknown;
      cascadeTracker?: unknown;
    } = {},
  ) {
    return createTaskSessionManagerHook(
      {
        directory: projectDir,
        client: overrides.client ?? {},
      } as never,
      {
        maxSessionsPerAgent: 3,
        maxRetainedSnapshots: 5,
        backgroundJobBoard: board,
        shouldManageSession: (sessionID: string) => sessionID === 'parent-1',
        laneControl,
        // No status polling in this test: the reconciler needs a real client.
        runtimeStatusReconcileDelayMs: 10_000_000,
        ...(overrides.revivedRunTracker
          ? { revivedRunTracker: overrides.revivedRunTracker as never }
          : {}),
        ...(overrides.cascadeTracker
          ? { cascadeTracker: overrides.cascadeTracker as never }
          : {}),
      },
    );
  }

  function fakeCascadeTracker() {
    return {
      noteChildAbort: mock(() => {}),
      noteOrchestratorAbort: mock(() => {}),
      noteOrchestratorBusy: mock(() => {}),
      noteOrchestratorIdle: mock(() => {}),
      flushAutoRevive: mock(async () => {}),
      dispose: mock(() => {}),
    };
  }

  test('server disposal tears the cascade tracker down', async () => {
    const cascadeTracker = fakeCascadeTracker();
    const hook = createHook(true, runningBoard(), { cascadeTracker });

    await hook.event({
      event: { type: 'server.instance.disposed', properties: {} },
    } as never);

    expect(cascadeTracker.dispose).toHaveBeenCalled();
  });

  /**
   * The plugin factory re-runs on every CONFIG update. A restart still pending
   * under `reviveOnCascade: 'auto'` must not fire after the user has just
   * switched it to `'off'`, so the generation that loses the directory loses
   * its tracker with it.
   */
  test('a newer hook generation tears down the previous cascade tracker', () => {
    const first = fakeCascadeTracker();
    createHook(true, runningBoard(), { cascadeTracker: first });
    expect(first.dispose).not.toHaveBeenCalled();

    const second = fakeCascadeTracker();
    createHook(true, runningBoard(), { cascadeTracker: second });

    expect(first.dispose).toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
  });

  test('an event flushes the mirror and publishes the sidecar', async () => {
    const board = runningBoard();
    const hook = createHook(true, board);

    expect(readServerInfo(serverInfoPath(projectDir))).toMatchObject({
      url: 'http://127.0.0.1:4096/',
      pid: process.pid,
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    } as never);

    const mirror = readLaneMirror(laneMirrorPath(projectDir));
    expect(mirror?.lanes).toEqual([
      expect.objectContaining({
        alias: 'fix-1',
        sessionID: 'child-1',
        agent: 'fixer',
        state: 'running',
      }),
    ]);
  });

  test('the plugin claims a stop intent written by the CLI', async () => {
    const board = runningBoard();
    const hook = createHook(true, board);
    const intentsFile = laneIntentsPath(projectDir);
    appendLaneIntent(intentsFile, {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'wrong file set',
    });

    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      cancelledByUser: { reason: 'wrong file set' },
    });
    // Consumed: a later abort of the same lane must not reuse the line.
    expect(readLaneIntents(intentsFile)).toEqual([]);
  });

  test('a stop intent for an ALREADY terminal lane is claimed on flush (S2)', async () => {
    // No abort follows a lane that was already dead, so the event-router claim
    // never fires; the mirror flush is what keeps the CLI's promise.
    const board = runningBoard();
    board.updateStatus({ taskID: 'child-1', state: 'error' });
    const hook = createHook(true, board);
    const intentsFile = laneIntentsPath(projectDir);
    appendLaneIntent(intentsFile, {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'stay dead',
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'other', status: { type: 'busy' } },
      },
    } as never);

    expect(board.get('child-1')?.cancelledByUser).toMatchObject({
      reason: 'stay dead',
    });
    expect(readLaneIntents(intentsFile)).toEqual([]);
    // The label is visible in the very file this flush wrote.
    expect(
      readLaneMirror(laneMirrorPath(projectDir))?.lanes[0]?.cancelledByUser,
    ).toMatchObject({ reason: 'stay dead' });
  });

  test('the sweep leaves a RUNNING lane intent for the abort event', async () => {
    const board = runningBoard();
    const hook = createHook(true, board);
    const intentsFile = laneIntentsPath(projectDir);
    appendLaneIntent(intentsFile, {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'kill it',
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    } as never);
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
    expect(readLaneIntents(intentsFile)).toHaveLength(1);

    // ...and the abort that follows claims it, exactly once.
    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);
    expect(board.get('child-1')?.cancelledByUser).toMatchObject({
      reason: 'kill it',
    });
    expect(readLaneIntents(intentsFile)).toEqual([]);
  });

  test('the sweep never relabels an orchestrator-owned cancellation', async () => {
    const board = runningBoard();
    const lease = board.acquireCancellationLease('child-1', 1);
    board.markCancelled('child-1', 'obsolete', Date.now(), {
      force: true,
      expectedGeneration: 1,
      cancellationLease: lease,
    });
    board.releaseLease(lease as NonNullable<typeof lease>);
    const hook = createHook(true, board);
    appendLaneIntent(laneIntentsPath(projectDir), {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'mine',
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'other', status: { type: 'busy' } },
      },
    } as never);
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
  });

  test('server.instance.disposed flushes, then removes the sidecar', async () => {
    const board = runningBoard();
    const hook = createHook(true, board);
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    await hook.event({
      event: { type: 'server.instance.disposed', properties: {} },
    } as never);

    expect(existsSync(serverInfoPath(projectDir))).toBe(false);
    expect(readLaneMirror(laneMirrorPath(projectDir))?.lanes[0]?.state).toBe(
      'completed',
    );
  });

  test('laneControl:false writes nothing and ignores CLI intents', async () => {
    const board = runningBoard();
    const hook = createHook(false, board);
    appendLaneIntent(laneIntentsPath(projectDir), {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'ignored',
    });

    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);

    expect(existsSync(laneMirrorPath(projectDir))).toBe(false);
    expect(existsSync(serverInfoPath(projectDir))).toBe(false);
    expect(board.get('child-1')?.cancelledByUser).toBeUndefined();
    // The intent stays on disk, unread.
    expect(readLaneIntents(laneIntentsPath(projectDir))).toHaveLength(1);
  });

  test('the plugin entry point passes the config flag through', async () => {
    // Wiring guard: the hook defaults laneControl OFF, so a dropped argument
    // in src/index.ts would silently disable the whole feature.
    const source = await Bun.file(
      path.join(import.meta.dir, '..', '..', 'index.ts'),
    ).text();
    expect(source).toContain('laneControl: runtime.backgroundJobs.laneControl');
    expect(source).toContain(
      'reviveOnCascade: runtime.backgroundJobs.reviveOnCascade',
    );
  });

  /**
   * `omos lanes revive` prompts from ANOTHER process, so the plugin only ever
   * sees a settled lane going busy. Claiming the intent it left behind is what
   * turns that into a registered revived run — which is what makes the parent
   * receive a `<task>` notification when the resumed lane finishes (probe B2:
   * nothing else ever tells it).
   */
  function reviveHarness(board: BackgroundJobBoard) {
    const registered: unknown[] = [];
    const revivedRunTracker = {
      captureBaseline: mock(async () => 'should-not-be-used'),
      register: mock((input: unknown) => {
        registered.push(input);
      }),
      isTracked: mock(() => true),
      probe: mock(async () => false),
      onTerminal: mock(() => {}),
      dispose: mock(() => {}),
    };
    const client = {
      session: {
        messages: mock(async () => ({
          data: [
            { info: { id: 'msg_user', role: 'user' }, parts: [] },
            {
              info: {
                id: 'msg_assistant_aborted',
                role: 'assistant',
                time: { completed: 5 },
              },
              parts: [],
            },
            // The turn the CLI just started: in flight, so it must NOT become
            // the tracker's baseline (nothing would ever come "after" it).
            { info: { id: 'msg_resume', role: 'user' }, parts: [] },
            { info: { id: 'msg_live', role: 'assistant' }, parts: [] },
          ],
        })),
      },
    };
    const hook = createHook(true, board, { client, revivedRunTracker });
    return { hook, revivedRunTracker, registered, client };
  }

  test('a claimed revive intent registers the run and labels the record', async () => {
    const board = runningBoard();
    board.updateStatus({ taskID: 'child-1', state: 'error' });
    const generationBefore = board.get('child-1')?.generation as number;
    const { hook, revivedRunTracker, registered } = reviveHarness(board);
    const intentsFile = laneIntentsPath(projectDir);
    appendLaneIntent(intentsFile, {
      at: Date.now(),
      action: 'revive',
      sessionID: 'child-1',
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    } as never);

    const record = board.get('child-1');
    expect(record?.state).toBe('running');
    expect(record?.generation).toBeGreaterThan(generationBefore);
    expect(record?.revivedByUser).toBeDefined();
    expect(registered).toEqual([
      expect.objectContaining({
        taskID: 'child-1',
        generation: record?.generation,
        parentSessionID: 'parent-1',
        // The last SETTLED message, not the turn now in flight.
        baselineMessageID: 'msg_resume',
      }),
    ]);
    expect(revivedRunTracker.probe).toHaveBeenCalled();
    // Claimed: a later busy signal must not re-adopt the same run.
    expect(readLaneIntents(intentsFile)).toEqual([]);
    expect(
      readLaneMirror(laneMirrorPath(projectDir))?.lanes[0]?.revivedByUser,
    ).toBeDefined();
  });

  test('a busy signal with no intent behind it is left alone', async () => {
    const board = runningBoard();
    board.updateStatus({ taskID: 'child-1', state: 'error' });
    const { hook, registered } = reviveHarness(board);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    } as never);

    expect(registered).toEqual([]);
    expect(board.get('child-1')?.state).toBe('error');
    expect(board.get('child-1')?.revivedByUser).toBeUndefined();
  });

  test('a running lane never consults the revive intents', async () => {
    const board = runningBoard();
    const { hook, registered } = reviveHarness(board);
    const intentsFile = laneIntentsPath(projectDir);
    appendLaneIntent(intentsFile, {
      at: Date.now(),
      action: 'revive',
      sessionID: 'child-1',
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    } as never);

    expect(registered).toEqual([]);
    expect(readLaneIntents(intentsFile)).toHaveLength(1);
  });

  test('an ESC on the orchestrator is attributed end to end', async () => {
    // The B1 ordering, through the real event router: child first, parent ~0.1s
    // later. One lane is enough when the parent's own abort is the evidence.
    const board = runningBoard();
    const { hook } = reviveHarness(board);

    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);
    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'parent-1', error: ABORT_ERROR },
      },
    } as never);

    const record = board.get('child-1');
    expect(record?.state).toBe('error');
    expect(record?.killedByCascade?.parentSessionID).toBe('parent-1');
    // (The mirror picks the stamp up on its next debounced flush; the
    // projection itself is pinned in lane-mirror.test.ts.)
  });

  test('a lane the user stopped is never attributed to the ESC', async () => {
    const board = runningBoard();
    const { hook } = reviveHarness(board);
    appendLaneIntent(laneIntentsPath(projectDir), {
      at: Date.now(),
      action: 'stop',
      sessionID: 'child-1',
      reason: 'wrong file set',
    });

    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);
    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'parent-1', error: ABORT_ERROR },
      },
    } as never);

    expect(board.get('child-1')?.cancelledByUser).toBeDefined();
    expect(board.get('child-1')?.killedByCascade).toBeUndefined();
  });

  test('a foreground-fallback abort of the orchestrator is not an ESC', async () => {
    const board = runningBoard();
    const hook = createTaskSessionManagerHook(
      { directory: projectDir, client: {} } as never,
      {
        maxSessionsPerAgent: 3,
        maxRetainedSnapshots: 5,
        backgroundJobBoard: board,
        shouldManageSession: (sessionID: string) => sessionID === 'parent-1',
        laneControl: true,
        runtimeStatusReconcileDelayMs: 10_000_000,
        // Fallback aborts the session to swap models: that abort is ours.
        isFallbackInProgress: (sessionID: string) => sessionID === 'parent-1',
      },
    );

    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: ABORT_ERROR },
      },
    } as never);
    await hook.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'parent-1', error: ABORT_ERROR },
      },
    } as never);

    expect(board.get('child-1')?.killedByCascade).toBeUndefined();
  });
});
