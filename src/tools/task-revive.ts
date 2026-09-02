import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { launchRetainedRun } from '../hooks/task-session-manager/revive-run';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { isReviveableRetainedJob } from '../utils/lane-state';
import { getClient } from '../utils/opencode-client';
import {
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';

/**
 * Whether a retained record may be revived in place.
 *
 * Re-exported (not re-implemented) from `src/utils/lane-state.ts`, which is
 * the copy `omos lanes revive` and the plugin's cascade auto-revive also use:
 * three callers disagreeing about what "revivable" means is the one bug none
 * of them would notice. Kept on this module's surface because tests assert a
 * specific terminal record stays revivable through the tool — notably a child
 * whose transport died, which is recorded as `error` precisely so this
 * predicate accepts it.
 */
export { isReviveableRetainedJob } from '../utils/lane-state';

const z = tool.schema;

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt.',
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(options, toolContext);
      const requested = args.task_id.trim();
      const prompt = args.prompt.trim();
      if (!requested) throw new Error('task_revive requires task_id');
      if (!prompt) throw new Error('task_revive requires prompt');

      const resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!resolved) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        requested,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };

      let cancelledForRevive = false;
      if (current.state === 'running') {
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
      }

      if (!cancelledForRevive && !isReviveableRetainedJob(current)) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      // The relaunch mechanism itself (lease, baseline fence, new generation,
      // tracker registration, supervisor, immediate probe) is shared with the
      // plugin's own revive paths — see `revive-run.ts`. Only the prompt body
      // and the wording stay here.
      let launched:
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        launched = await launchRetainedRun(
          {
            input: options.input,
            backgroundJobBoard: options.backgroundJobBoard,
            backgroundJobSupervisor: options.backgroundJobSupervisor,
            revivedRunTracker,
          },
          {
            record: current,
            label: 'task_revive',
            sendPrompt: async () => {
              const session = getClient(options.input).session;
              if (typeof session.promptAsync !== 'function') {
                throw new Error(
                  'The host session does not support promptAsync',
                );
              }
              const response = await session.promptAsync({
                path: { id: current.taskID },
                query: { directory: options.input.directory },
                body: {
                  agent: current.agent,
                  parts: [{ type: 'text', text: prompt }],
                },
              });
              const responseError = getApiError(response);
              if (responseError !== undefined) {
                throw new Error(errorText(responseError));
              }
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'relaunch lease unavailable') {
          throw new Error(
            `Task ${requested} cannot be revived: relaunch lease unavailable`,
          );
        }
        throw new Error(`Task ${requested} revive failed: ${message}`);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(latest);
    },
  });

  return { task_revive };
}

function renderReviveOutput(
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `task_id: ${record.taskID}`,
    `generation: ${record.generation}`,
    `state: ${state}`,
    `status: ${state === 'running' ? 'started' : state}`,
  ];
  if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function assertOrchestrator(
  options: TaskReviveToolOptions,
  toolContext: { sessionID?: string; agent?: string } | undefined,
): string {
  const parentSessionID = toolContext?.sessionID;
  if (!parentSessionID) throw new Error('task_revive requires sessionID');
  if (toolContext.agent && toolContext.agent !== 'orchestrator') {
    throw new Error('task_revive can only be used by orchestrator');
  }
  if (!options.shouldManageSession(parentSessionID)) {
    throw new Error('task_revive can only be used in orchestrator sessions');
  }
  return parentSessionID;
}

function getApiError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  return record.error === undefined || record.error === null
    ? undefined
    : record.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
