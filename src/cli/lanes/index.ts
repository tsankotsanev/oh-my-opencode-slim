/**
 * `omos lanes` — zero-token control surface for background subagent lanes.
 *
 * Entry point only: parsing lives in `./args`, the lane-mirror reader in
 * `./board`, server discovery in `./server`, and the commands in
 * `./commands`. Everything is dependency-injected through {@link LanesDeps}
 * so the whole group is testable with a mocked SDK client and a temp
 * `XDG_DATA_HOME`, with no live server anywhere near the test suite.
 *
 * Import rule for this group: nothing under `src/cli/lanes/` imports from
 * `src/hooks/`. The shared vocabulary (mirror paths and shapes, intent format,
 * server-URL resolution, `withAgent`) therefore lives in `src/utils/`, where
 * both sides reach it without dragging the board class or the hook runtime
 * into the CLI bundle. (`src/cli/install.ts` has a pre-existing edge into
 * `hooks/auto-update-checker/skill-sync`; that one is install-time only and is
 * not a precedent for the lane commands, which must stay bundle-light.)
 */

import path from 'node:path';
import { LANES_HELP, type LanesArgs, parseLanesArgs } from './args';
import {
  type LanesDeps,
  runLanesList,
  runLanesSay,
  runLanesShow,
  runLanesStop,
} from './commands';
import { createLaneClient } from './server';

export type { LanesArgs } from './args';
export { LANES_HELP, parseLanesArgs } from './args';

/**
 * Resolve `--dir` the way the mirror hashes it.
 *
 * `laneMirrorPath` canonicalizes internally, but resolving here too keeps the
 * directory printed in messages absolute rather than `.`.
 */
export function resolveLanesDirectory(dir: string | undefined): string {
  return path.resolve(dir ?? process.cwd());
}

function defaultDeps(): LanesDeps {
  return {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
    createClient: createLaneClient,
  };
}

/**
 * Run a parsed command. Returns a process exit code; never throws.
 *
 * The blanket catch is deliberate: `omos lanes` is reached for when something
 * is already wrong, and a Node stack trace on top of that is noise, not
 * information.
 */
export async function runLanesCommand(
  parsed: LanesArgs,
  deps: LanesDeps = defaultDeps(),
): Promise<number> {
  if (parsed.command === 'help') {
    deps.out(LANES_HELP);
    return 0;
  }
  if (parsed.command === 'error') {
    deps.err(parsed.message);
    deps.err('');
    deps.err('Run "omos lanes --help" for usage.');
    return 1;
  }

  const directory = resolveLanesDirectory(parsed.dir);

  try {
    switch (parsed.command) {
      case 'list':
        return runLanesList(directory, parsed.json, deps);
      case 'show':
        return await runLanesShow(
          {
            directory,
            selector: parsed.selector,
            serverFlag: parsed.server,
            json: parsed.json,
            force: parsed.force,
            count: parsed.count,
          },
          deps,
        );
      case 'stop':
        return await runLanesStop(
          {
            directory,
            selector: parsed.selector,
            serverFlag: parsed.server,
            json: parsed.json,
            force: parsed.force,
            reason: parsed.reason,
          },
          deps,
        );
      case 'say':
        return await runLanesSay(
          {
            directory,
            selector: parsed.selector,
            serverFlag: parsed.server,
            json: parsed.json,
            force: parsed.force,
            text: parsed.text,
          },
          deps,
        );
    }
  } catch (error) {
    deps.err(
      `omos lanes failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** CLI-facing shim: parse argv then run. */
export async function lanes(argv: string[], deps?: LanesDeps): Promise<number> {
  return runLanesCommand(parseLanesArgs(argv), deps);
}
