/**
 * How `omo lanes` finds the OpenCode server to talk to.
 *
 * The CLI runs in a different terminal than the server, so it cannot ask the
 * plugin anything. Discovery order, most-explicit first:
 *
 *   1. `--server <url>` — the user said so.
 *   2. `<data dir>/background-jobs/<key>.server.json` — the sidecar the plugin
 *      writes for exactly this purpose (see `src/utils/lane-control.ts`).
 *   3. `$OMO_OPENCODE_SERVER_URL` — for hosts where the plugin could not
 *      derive its own URL in-process.
 *
 * Every failure produces a sentence that tells the user what to do next.
 * `omo lanes` is reached for at the worst possible moment (a lane is
 * misbehaving), so a stack trace here is a bug.
 */

import {
  readServerInfo,
  SIDECAR_REFRESH_MS,
  SIDECAR_STALE_AFTER_MS,
  serverInfoPath,
} from '../../utils/lane-control';
import { canonicalDirectory } from '../../utils/lane-mirror';
import { serverUrlFromEnv, validServerUrl } from '../../utils/server-url';

export interface ServerTarget {
  url: string;
  source: 'flag' | 'sidecar' | 'env';
  /** Sidecar only: the server process id and last heartbeat. */
  pid?: number;
  updatedAt?: number;
  /** Sidecar only: the directory the server reported owning. */
  directory?: string;
}

export type ServerDiscovery =
  | { ok: true; target: ServerTarget }
  | { ok: false; message: string };

export interface DiscoverServerOptions {
  serverFlag?: string;
  /** Test seam; defaults to the sidecar path for `directory`. */
  sidecarFile?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for liveness probing; defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

/**
 * Is the process that wrote the sidecar still running?
 *
 * Signal 0 performs the permission/existence check without delivering
 * anything. `ESRCH` means no such process; `EPERM` means it exists but is
 * owned by someone else, which for our purposes counts as alive.
 */
function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function discoverServer(
  directory: string,
  options: DiscoverServerOptions = {},
): ServerDiscovery {
  if (options.serverFlag) {
    const url = validServerUrl(options.serverFlag);
    if (!url) {
      return {
        ok: false,
        message: `--server "${options.serverFlag}" is not an http(s) URL (expected something like http://127.0.0.1:4096)`,
      };
    }
    return { ok: true, target: { url, source: 'flag' } };
  }

  const file = options.sidecarFile ?? serverInfoPath(directory);
  const info = readServerInfo(file);
  const fromSidecar = info ? validServerUrl(info.url) : null;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => Date.now());

  // S1: a sidecar is only trustworthy if the process that wrote it is still
  // running AND it is talking about this directory. Neither is guaranteed:
  // the file survives SIGKILL (dispose never runs), and `opencode serve`
  // reuses fixed ports — so a stale record can point at a live server
  // belonging to a DIFFERENT project, where `say` would start a turn in
  // somebody else's session.
  let staleReason: string | undefined;
  if (info && fromSidecar) {
    // Canonicalized on both sides (the sidecar writes the same form), so a
    // symlinked --dir does not read as "a different project".
    const expected = canonicalDirectory(directory);
    if (info.directory && canonicalDirectory(info.directory) !== expected) {
      return {
        ok: false,
        message: [
          `The server sidecar for ${expected} belongs to a different project.`,
          `  sidecar: ${file}`,
          `  it reports: ${info.directory}`,
          '',
          'Acting on it could reach into another project’s sessions, so this is',
          'a hard refusal. Pass the right URL with --server, or restart OpenCode',
          'in this directory.',
        ].join('\n'),
      };
    }
    if (!isAlive(info.pid)) {
      staleReason = `pid ${info.pid} is not running`;
    } else if (
      info.updatedAt > 0 &&
      now() - info.updatedAt > SIDECAR_STALE_AFTER_MS
    ) {
      staleReason = `it has not been refreshed in ${Math.round(
        (now() - info.updatedAt) / 60_000,
      )} minutes (a live server refreshes every ${SIDECAR_REFRESH_MS / 1000}s)`;
    }
  }

  if (fromSidecar && !staleReason) {
    return {
      ok: true,
      target: {
        url: fromSidecar,
        source: 'sidecar',
        pid: info?.pid,
        updatedAt: info?.updatedAt,
        directory: info?.directory,
      },
    };
  }

  const fromEnv = serverUrlFromEnv(options.env ?? process.env);
  if (fromEnv) {
    return { ok: true, target: { url: fromEnv, source: 'env' } };
  }

  if (staleReason) {
    return {
      ok: false,
      message: [
        `The server sidecar for ${directory} is stale: ${staleReason}.`,
        `  sidecar: ${file}`,
        '',
        'The OpenCode server it described is gone (a crash or SIGKILL skips the',
        'cleanup that would have removed this file), so acting on it could reach',
        'the wrong server, or none at all.',
        '',
        'Fixes:',
        '  - restart OpenCode in that directory, then retry;',
        '  - or pass the current URL:  omo lanes <command> --server http://127.0.0.1:<port>',
      ].join('\n'),
    };
  }

  return {
    ok: false,
    message: [
      `No OpenCode server recorded for ${directory}.`,
      `Looked for: ${file}`,
      '',
      'Fixes, in order of convenience:',
      '  - start (or restart) OpenCode in that directory so the plugin can',
      '    write the sidecar, then retry;',
      '  - pass the URL directly:  omo lanes <command> --server http://127.0.0.1:<port>',
      '  - or export OMO_OPENCODE_SERVER_URL in both shells.',
      '',
      'The port is printed by `opencode serve`; for the TUI it is also visible',
      'in the OpenCode logs.',
    ].join('\n'),
  };
}

/** Minimal SDK surface the lane commands need; keeps mocking honest. */
export interface LaneSdkResponse {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}

export interface LaneClient {
  session: {
    /**
     * Needed to prove a raw `ses_…` is a background CHILD (`parentID` set)
     * before aborting or steering it. Aborting a parent is a whole-tree kill.
     */
    get(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<LaneSdkResponse> | LaneSdkResponse;
    messages(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<LaneSdkResponse> | LaneSdkResponse;
    abort(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<LaneSdkResponse> | LaneSdkResponse;
    status(input?: unknown): Promise<LaneSdkResponse> | LaneSdkResponse;
    promptAsync(input: {
      path: { id: string };
      query?: { directory?: string };
      body: unknown;
    }): Promise<LaneSdkResponse> | LaneSdkResponse;
  };
}

/**
 * Build a real SDK client.
 *
 * Imported dynamically so the common `omo lanes list` path (which needs no
 * server at all) never pays for loading the SDK, and so tests can inject a
 * mock client without the SDK being present.
 */
export async function createLaneClient(
  url: string,
  directory: string,
): Promise<LaneClient> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  return createOpencodeClient({
    baseUrl: url,
    directory,
  }) as unknown as LaneClient;
}

/**
 * Turn any SDK/transport failure into one readable line.
 *
 * The SDK reports errors two ways — a rejected promise for transport faults
 * and an `{ error }` field for HTTP ones — and both reach the user as the
 * same class of problem: "the server did not do what you asked".
 */
export function describeSdkError(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code)
        : undefined;
    return causeCode ? `${error.message} (${causeCode})` : error.message;
  }
  if (typeof error === 'object') {
    const shape = error as { message?: unknown; name?: unknown };
    if (typeof shape.message === 'string') return shape.message;
    if (typeof shape.name === 'string') return shape.name;
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown error';
    }
  }
  return String(error);
}

/** `true` when the server is unreachable rather than merely unhappy. */
export function isConnectionError(error: unknown): boolean {
  const text = describeSdkError(error).toLowerCase();
  return (
    text.includes('econnrefused') ||
    text.includes('fetch failed') ||
    text.includes('failed to fetch') ||
    text.includes('socket hang up') ||
    text.includes('enotfound') ||
    text.includes('econnreset')
  );
}
