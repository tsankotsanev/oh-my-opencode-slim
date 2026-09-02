import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLaneIntent,
  consumeReviveIntent,
  consumeStopIntent,
  createServerSidecar,
  INTENT_RETENTION_MS,
  laneIntentsPath,
  RESUME_PROMPT_TEXT,
  REVIVE_INTENT_WINDOW_MS,
  readLaneIntents,
  readServerInfo,
  SIDECAR_REFRESH_MS,
  STOP_INTENT_WINDOW_MS,
  serverInfoPath,
  writeServerInfo,
} from './lane-control';
import { canonicalDirectory, laneStateDir } from './lane-mirror';

let dataHome: string;
let projectDir: string;
let originalDataHome: string | undefined;

beforeEach(() => {
  originalDataHome = process.env.XDG_DATA_HOME;
  dataHome = mkdtempSync(path.join(os.tmpdir(), 'lane-control-data-'));
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'lane-control-project-'));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('server sidecar', () => {
  test('paths sit beside the mirror, keyed by directory', () => {
    expect(path.dirname(serverInfoPath(projectDir))).toBe(laneStateDir());
    expect(serverInfoPath(projectDir)).toMatch(/\.server\.json$/);
    expect(laneIntentsPath(projectDir)).toMatch(/\.intents\.jsonl$/);
  });

  function sidecarHarness(
    options: { enabled?: boolean; url?: string | null } = {},
  ) {
    let now = 1_000_000;
    // `??` would turn an explicit null ("host has no URL yet") into the default.
    let url: string | null =
      'url' in options
        ? (options.url as string | null)
        : 'http://127.0.0.1:4096/';
    const intervals: Array<{ fn: () => void }> = [];
    const sidecar = createServerSidecar({
      directory: projectDir,
      enabled: options.enabled ?? true,
      resolveServerUrl: () => url,
      now: () => now,
      pid: 4242,
      setIntervalFn: ((fn: () => void) => {
        const timer = { fn };
        intervals.push(timer);
        return timer as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalFn: ((timer: unknown) => {
        const index = intervals.indexOf(timer as { fn: () => void });
        if (index >= 0) intervals.splice(index, 1);
      }) as unknown as typeof clearInterval,
    });
    return {
      sidecar,
      read: () => readServerInfo(sidecar.file),
      tick() {
        for (const timer of [...intervals]) timer.fn();
      },
      intervals: () => intervals.length,
      advance(ms: number) {
        now += ms;
      },
      setUrl(next: string | null) {
        url = next;
      },
      at: () => now,
    };
  }

  test('publishes url, canonical directory, pid and heartbeat on creation', () => {
    const h = sidecarHarness();
    expect(h.read()).toEqual({
      url: 'http://127.0.0.1:4096/',
      directory: canonicalDirectory(projectDir),
      pid: 4242,
      startedAt: 1_000_000,
      updatedAt: 1_000_000,
    });
  });

  test('heartbeat writes are coalesced but a changed URL lands at once', () => {
    const h = sidecarHarness();
    h.advance(1_000);
    h.sidecar.refresh();
    expect(h.read()?.updatedAt).toBe(1_000_000);

    h.setUrl('http://127.0.0.1:5000/');
    h.sidecar.refresh();
    expect(h.read()).toMatchObject({
      url: 'http://127.0.0.1:5000/',
      updatedAt: 1_001_000,
      // startedAt is the first sighting, not the URL change.
      startedAt: 1_000_000,
    });

    h.advance(30_000);
    h.sidecar.refresh();
    expect(h.read()?.updatedAt).toBe(1_031_000);
  });

  test('the timer refresh always writes (it is the liveness proof)', () => {
    const h = sidecarHarness();
    h.advance(SIDECAR_REFRESH_MS);
    h.tick();
    expect(h.read()?.updatedAt).toBe(1_000_000 + SIDECAR_REFRESH_MS);
  });

  test('no URL yet writes nothing and does not throw', () => {
    const h = sidecarHarness({ url: null });
    expect(existsSync(h.sidecar.file)).toBe(false);
    h.setUrl('http://127.0.0.1:4096/');
    h.sidecar.refresh();
    expect(h.read()?.url).toBe('http://127.0.0.1:4096/');
  });

  test('a throwing resolver is swallowed', () => {
    const sidecar = createServerSidecar({
      directory: projectDir,
      enabled: true,
      resolveServerUrl: () => {
        throw new Error('host not ready');
      },
    });
    expect(() => {
      sidecar.refresh({ force: true });
    }).not.toThrow();
    expect(existsSync(sidecar.file)).toBe(false);
  });

  test('dispose removes the record and stops the timer', () => {
    const h = sidecarHarness();
    expect(existsSync(h.sidecar.file)).toBe(true);
    h.sidecar.dispose();
    expect(existsSync(h.sidecar.file)).toBe(false);
    expect(h.intervals()).toBe(0);
    // Post-dispose refreshes must not resurrect a dead server's record.
    h.sidecar.refresh({ force: true });
    expect(existsSync(h.sidecar.file)).toBe(false);
  });

  test('disabled never touches the filesystem', () => {
    const h = sidecarHarness({ enabled: false });
    h.sidecar.refresh({ force: true });
    h.sidecar.dispose();
    expect(existsSync(h.sidecar.file)).toBe(false);
    expect(h.intervals()).toBe(0);
  });

  test('malformed sidecars read as undefined', () => {
    const file = serverInfoPath(projectDir);
    mkdirSync(path.dirname(file), { recursive: true });
    for (const body of ['{not json', '{}', '{"url":""}', '[]', 'null']) {
      writeFileSync(file, body, 'utf8');
      expect(readServerInfo(file)).toBeUndefined();
    }
  });

  test('an atomic write leaves no tmp file behind', () => {
    const file = serverInfoPath(projectDir);
    expect(
      writeServerInfo(file, {
        url: 'http://x.test/',
        directory: projectDir,
        pid: 1,
        startedAt: 1,
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});

describe('stop intents', () => {
  test('append-then-claim carries the reason and consumes the line', () => {
    const file = laneIntentsPath(projectDir);
    expect(
      appendLaneIntent(file, {
        at: 1_000,
        action: 'stop',
        sessionID: 'ses_child1',
        reason: 'wrong file set',
      }),
    ).toBe(true);

    const claimed = consumeStopIntent(file, 'ses_child1', { now: 1_500 });
    expect(claimed?.reason).toBe('wrong file set');
    // Claimed exactly once: a later abort of the same lane is anonymous.
    expect(
      consumeStopIntent(file, 'ses_child1', { now: 1_600 }),
    ).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test('claims the NEWEST matching line and keeps the others', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, {
      at: 1_000,
      action: 'stop',
      sessionID: 'ses_a',
      reason: 'older',
    });
    appendLaneIntent(file, {
      at: 1_100,
      action: 'stop',
      sessionID: 'ses_b',
      reason: 'other lane',
    });
    appendLaneIntent(file, {
      at: 1_200,
      action: 'stop',
      sessionID: 'ses_a',
      reason: 'newer',
    });

    expect(consumeStopIntent(file, 'ses_a', { now: 1_300 })?.reason).toBe(
      'newer',
    );
    const left = readLaneIntents(file, { now: 1_300 });
    expect(left.map((intent) => intent.reason)).toEqual([
      'older',
      'other lane',
    ]);
  });

  test('a line older than the window does not explain this abort', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, { at: 1_000, action: 'stop', sessionID: 'ses_a' });
    expect(
      consumeStopIntent(file, 'ses_a', {
        now: 1_000 + STOP_INTENT_WINDOW_MS + 1,
      }),
    ).toBeUndefined();
    // Still retained (only the 60s attribution window passed, not retention).
    expect(
      readLaneIntents(file, { now: 1_000 + STOP_INTENT_WINDOW_MS + 1 }),
    ).toHaveLength(1);
  });

  test('clock skew in the CLI still counts as recent', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, { at: 5_000, action: 'stop', sessionID: 'ses_a' });
    expect(consumeStopIntent(file, 'ses_a', { now: 1_000 })).toBeDefined();
  });

  test('expired lines are pruned on read', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, { at: 1_000, action: 'stop', sessionID: 'ses_a' });
    const now = 1_000 + INTENT_RETENTION_MS + 1;
    expect(readLaneIntents(file, { now })).toEqual([]);
    expect(consumeStopIntent(file, 'ses_a', { now })).toBeUndefined();
    // The pruned file is removed rather than left holding dead lines.
    expect(existsSync(file)).toBe(false);
  });

  test('a torn tail line and junk are skipped, valid lines survive', () => {
    const file = laneIntentsPath(projectDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ at: 1_000, action: 'stop', sessionID: 'ses_a' })}\n` +
        'not json\n' +
        `${JSON.stringify({ at: 1_050, action: 'unknown', sessionID: 'ses_a' })}\n` +
        `${JSON.stringify({ action: 'stop', sessionID: 'ses_a' })}\n` +
        '{"at":1200,"action":"stop","sessionID":"ses_a"',
      'utf8',
    );
    expect(readLaneIntents(file, { now: 1_300 })).toEqual([
      { at: 1_000, action: 'stop', sessionID: 'ses_a', reason: undefined },
    ]);
    expect(consumeStopIntent(file, 'ses_a', { now: 1_300 })?.at).toBe(1_000);
  });

  test('a missing file is the cheap normal case', () => {
    const file = laneIntentsPath(projectDir);
    expect(readLaneIntents(file)).toEqual([]);
    expect(consumeStopIntent(file, 'ses_a')).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test('an oversized file is truncated to its newest bytes', () => {
    const file = laneIntentsPath(projectDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const filler = `${JSON.stringify({
      at: 1_000,
      action: 'stop',
      sessionID: 'ses_filler',
      reason: 'x'.repeat(500),
    })}\n`;
    // ~300 KB of history, past the 256 KB read cap.
    for (let index = 0; index < 600; index++) appendFileSync(file, filler);
    appendLaneIntent(file, {
      at: 1_100,
      action: 'stop',
      sessionID: 'ses_target',
      reason: 'newest',
    });
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(256 * 1024);
    expect(consumeStopIntent(file, 'ses_target', { now: 1_200 })?.reason).toBe(
      'newest',
    );
  });

  test('an unwritable path reports false instead of throwing', () => {
    const blocked = path.join(projectDir, 'blocked');
    mkdirSync(blocked, { recursive: true });
    expect(
      appendLaneIntent(blocked, {
        at: 1,
        action: 'stop',
        sessionID: 'ses_a',
      }),
    ).toBe(false);
  });
});

describe('revive intents', () => {
  test('a revive line is claimed by the busy signal it explains, once', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, {
      at: 1_000,
      action: 'revive',
      sessionID: 'ses_child1',
    });

    expect(
      consumeReviveIntent(file, 'ses_child1', { now: 1_200 })?.action,
    ).toBe('revive');
    expect(
      consumeReviveIntent(file, 'ses_child1', { now: 1_300 }),
    ).toBeUndefined();
  });

  test('stop and revive never claim each other', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, {
      at: 1_000,
      action: 'revive',
      sessionID: 'ses_child1',
    });
    appendLaneIntent(file, {
      at: 1_010,
      action: 'stop',
      sessionID: 'ses_child1',
      reason: 'no, stay dead',
    });

    // The user changed their mind: the stop must reach the stop reader and the
    // revive must not be answered by it (or the lane would be relabelled).
    expect(consumeStopIntent(file, 'ses_child1', { now: 1_100 })?.reason).toBe(
      'no, stay dead',
    );
    expect(
      consumeReviveIntent(file, 'ses_child1', { now: 1_100 })?.action,
    ).toBe('revive');
  });

  test('an old revive line expires rather than explaining a later turn', () => {
    const file = laneIntentsPath(projectDir);
    appendLaneIntent(file, {
      at: 1_000,
      action: 'revive',
      sessionID: 'ses_child1',
    });

    expect(
      consumeReviveIntent(file, 'ses_child1', {
        now: 1_000 + REVIVE_INTENT_WINDOW_MS + 1,
      }),
    ).toBeUndefined();
  });

  test('the resume prompt is one shared constant, and says what it must', () => {
    // Both the CLI and the plugin's auto-revive send THIS text; two copies
    // would be an invisible inconsistency in what a resumed lane is told.
    expect(RESUME_PROMPT_TEXT).toContain('You were interrupted by an abort');
    // The one thing the lane cannot know: an abort can land mid-operation.
    expect(RESUME_PROMPT_TEXT).toContain('re-check its current state first');
  });
});
