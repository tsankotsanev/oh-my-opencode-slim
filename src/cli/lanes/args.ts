/**
 * Argument parsing for the `omo lanes` command group.
 *
 * Pure and total: every input maps to a value, including malformed input,
 * which becomes `{ command: 'error' }`. The commands themselves therefore
 * never have to validate arguments, and the parser is exhaustively testable
 * without touching a filesystem or a server.
 */

export interface LanesCommonArgs {
  /** Project directory whose lanes to read. Defaults to the cwd. */
  dir?: string;
  json: boolean;
}

export interface LanesTargetedArgs extends LanesCommonArgs {
  /** Alias (`fix-1`) or raw `ses_…` session id. */
  selector: string;
  /** Explicit server URL, overriding the sidecar. */
  server?: string;
  /**
   * Override the safety refusals: aborting/steering a session that is not a
   * verified background child, a lane that is not active on this server, or a
   * lane whose recorded state says the message cannot land.
   *
   * Never bypasses the agent requirement — that one is not a safety rail, it
   * is a correctness rule with no safe fallback (probe A2).
   */
  force: boolean;
}

export type LanesArgs =
  | { command: 'help' }
  | { command: 'error'; message: string }
  | ({ command: 'list' } & LanesCommonArgs)
  | ({ command: 'show'; count: number } & LanesTargetedArgs)
  | ({ command: 'stop'; reason?: string } & LanesTargetedArgs)
  | ({ command: 'say'; text: string } & LanesTargetedArgs);

const DEFAULT_SHOW_COUNT = 20;
const MAX_SHOW_COUNT = 500;

const KNOWN_SUBCOMMANDS = new Set(['list', 'show', 'stop', 'say']);

/**
 * Subcommands that are planned but not implemented yet.
 *
 * Named explicitly so `omo lanes revive fix-1` gets a straight answer instead
 * of being reinterpreted as `list` with a stray positional.
 */
const RESERVED_SUBCOMMANDS = new Map<string, string>([
  [
    'revive',
    'Reviving a lane is not available from the CLI yet. Ask the orchestrator to run task_revive(task_id: "<alias>"); a stopped lane keeps its session, so it can be resumed in place.',
  ],
]);

interface Flags {
  dir?: string;
  server?: string;
  reason?: string;
  json: boolean;
  force: boolean;
  count?: number;
  positionals: string[];
  error?: string;
}

/**
 * Split flags from positionals in one pass.
 *
 * Both `--flag value` and `--flag=value` are accepted because users type
 * both, and a "missing value" is reported as an error rather than silently
 * swallowing the next positional (which for `say` would send the wrong text
 * to a live agent).
 */
function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    json: false,
    force: false,
    positionals: [],
  };

  const takeValue = (
    name: string,
    inline: string | undefined,
    index: number,
  ): { value?: string; nextIndex: number } => {
    if (inline !== undefined) {
      if (inline.length === 0) {
        flags.error ??= `${name} needs a value`;
        return { nextIndex: index };
      }
      return { value: inline, nextIndex: index };
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith('-')) {
      flags.error ??= `${name} needs a value`;
      return { nextIndex: index };
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;

    if (arg === '--') {
      // Everything after `--` is literal: lets `omo lanes say fix-1 -- --json`
      // send text that starts with a dash.
      flags.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === '-h' || arg === '--help') {
      flags.error ??= '__help__';
      continue;
    }

    if (arg === '--json') {
      flags.json = true;
      continue;
    }

    if (arg === '--force') {
      flags.force = true;
      continue;
    }

    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline =
      arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;

    if (name === '--dir') {
      const taken = takeValue('--dir', inline, index);
      if (taken.value) flags.dir = taken.value;
      index = taken.nextIndex;
      continue;
    }
    if (name === '--server') {
      const taken = takeValue('--server', inline, index);
      if (taken.value) flags.server = taken.value;
      index = taken.nextIndex;
      continue;
    }
    if (name === '--reason') {
      const taken = takeValue('--reason', inline, index);
      if (taken.value) flags.reason = taken.value;
      index = taken.nextIndex;
      continue;
    }
    if (name === '-n' || name === '--count') {
      const taken = takeValue(name, inline, index);
      index = taken.nextIndex;
      if (taken.value === undefined) continue;
      const parsed = Number(taken.value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        flags.error ??= `${name} needs a positive integer, got "${taken.value}"`;
        continue;
      }
      flags.count = Math.min(parsed, MAX_SHOW_COUNT);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      flags.error ??= `Unknown lanes option: ${arg}`;
      continue;
    }

    flags.positionals.push(arg);
  }

  return flags;
}

export function parseLanesArgs(args: string[]): LanesArgs {
  const [maybeSubcommand] = args;
  if (maybeSubcommand && RESERVED_SUBCOMMANDS.has(maybeSubcommand)) {
    return {
      command: 'error',
      message: RESERVED_SUBCOMMANDS.get(maybeSubcommand) as string,
    };
  }
  const subcommand =
    maybeSubcommand && KNOWN_SUBCOMMANDS.has(maybeSubcommand)
      ? maybeSubcommand
      : 'list';
  const rest = subcommand === maybeSubcommand ? args.slice(1) : args;

  const flags = parseFlags(rest);
  if (flags.error === '__help__') return { command: 'help' };
  if (flags.error) return { command: 'error', message: flags.error };

  const common: LanesCommonArgs = { dir: flags.dir, json: flags.json };

  if (subcommand === 'list') {
    if (flags.force) {
      return {
        command: 'error',
        message: '--force has no meaning for "lanes list" (it reads only)',
      };
    }
    if (flags.positionals.length > 0) {
      return {
        command: 'error',
        message: `Unexpected argument for "lanes list": ${flags.positionals[0]}. Did you mean "omo lanes show ${flags.positionals[0]}"?`,
      };
    }
    return { command: 'list', ...common };
  }

  const [selector, ...extra] = flags.positionals;
  if (!selector) {
    return {
      command: 'error',
      message: `"lanes ${subcommand}" needs a lane alias or session id (see "omo lanes list")`,
    };
  }

  const targeted: LanesTargetedArgs = {
    ...common,
    selector,
    server: flags.server,
    force: flags.force,
  };

  if (subcommand === 'show') {
    if (extra.length > 0) {
      return {
        command: 'error',
        message: `Unexpected argument for "lanes show": ${extra[0]}`,
      };
    }
    return {
      command: 'show',
      count: flags.count ?? DEFAULT_SHOW_COUNT,
      ...targeted,
    };
  }

  if (subcommand === 'stop') {
    if (extra.length > 0) {
      return {
        command: 'error',
        message: `Unexpected argument for "lanes stop": ${extra[0]}. Use --reason "…" to record why.`,
      };
    }
    return { command: 'stop', reason: flags.reason, ...targeted };
  }

  // say: everything after the selector is the message. Joining (rather than
  // requiring one quoted argument) means an unquoted sentence still works.
  const text = extra.join(' ').trim();
  if (!text) {
    return {
      command: 'error',
      message: '"lanes say" needs a message: omo lanes say <alias> "<text>"',
    };
  }
  return { command: 'say', text, ...targeted };
}

export const LANES_HELP = `Usage: omo lanes <command> [OPTIONS]

Inspect and steer the background subagent lanes of a running OpenCode server
from a second terminal, without spending an orchestrator turn.

Commands:
  list                       Lanes recorded for this project (no server needed)
  show   <alias|ses_id>      Print the tail of a lane's transcript
  stop   <alias|ses_id>      Abort one lane (the session survives, resumable)
  say    <alias|ses_id> ...  Queue an instruction for a running lane

Options:
  --dir <path>               Project directory (default: current directory)
  --server <url>             OpenCode server URL (default: from the sidecar
                             written by the plugin, or $OMO_OPENCODE_SERVER_URL)
  -n, --count <n>            Messages to print for "show" (default: 20)
  --reason "<text>"          Why you stopped the lane; shown to the orchestrator
  --force                    Override the safety refusals (see Notes)
  --json                     Machine-readable output
  -h, --help                 Show this message

Examples:
  omo lanes
  omo lanes list --json
  omo lanes show fix-1 -n 5
  omo lanes stop ora-2 --reason "wrong file set"
  omo lanes say fix-1 "also update the codemap"

Notes:
  - "list" reads a local mirror the plugin writes. It is a convenience copy,
    not a source of truth: the plugin itself reconstructs live lanes from the
    orchestrator's transcript, so a lane can be real while the mirror lags.
    Every command that acts on a lane re-checks the server first.
  - "say" is queued: the lane processes it after its current step, and the text
    becomes part of the result the orchestrator eventually sees.
  - "stop" leaves the session intact; the orchestrator learns about it on its
    next turn at no token cost, labelled as your cancellation, and can resume
    the lane in place with task_revive.
  - These commands refuse, and suggest --force, when the target is not a
    verified background child (aborting an orchestrator kills ALL of its lanes
    — use ESC in the TUI for that), is not active on the target server, or is
    in a state where a message cannot reach it.
  - --force never skips the agent requirement: "say" always sends the lane's
    own agent, or refuses. Omitting it would permanently rewrite the session
    to the default "build" agent.
`;
