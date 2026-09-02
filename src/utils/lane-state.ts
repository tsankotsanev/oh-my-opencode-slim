/**
 * The one predicate both processes use to decide whether a settled lane can be
 * resumed in its own session.
 *
 * It lives in `src/utils` (a leaf: no board class, no hook runtime, no SDK)
 * because three callers need exactly the same answer and a second
 * implementation would diverge silently:
 *
 *   - `src/tools/task-revive.ts` — the orchestrator's `task_revive`, which
 *     re-exports this as its own `isReviveableRetainedJob`;
 *   - `src/hooks/task-session-manager/` — the cascade auto-revive and the
 *     adoption of a run the CLI just prompted;
 *   - `src/cli/lanes/` — `omos lanes revive`, which reads the narrow lane
 *     mirror record and must refuse exactly what the tool refuses.
 *
 * Structural on purpose ({@link RetainedJobView}): the board record and the
 * mirror projection share only these three fields, and the CLI must not import
 * the board.
 */

import type { BackgroundJobState } from './background-job-board';

/**
 * The fields a revivability decision is allowed to depend on.
 *
 * Deliberately minimal — anything else (a cascade stamp, a user cancel label,
 * liveness) is a POLICY question for the caller, not part of "is this session
 * retained and settled".
 */
export interface RetainedJobView {
  state: BackgroundJobState;
  statusUncertain: boolean;
  /** Set on `reconciled` records to carry the outcome that was reconciled. */
  terminalState?: string;
}

/**
 * Whether a retained (non-cancelled-for-revive) record may be revived in
 * place.
 *
 * `statusUncertain` is decisive against revival: the record itself says the
 * plugin does not trust its own reading of this lane, and prompting a session
 * that may still be mid-turn is the corruption class every lane command
 * guards against.
 *
 * `stopped` is deliberately absent. That state means "the runtime reports the
 * child no longer executes but no result explained why", which upstream treats
 * as unproven — `resolveRecoverable` requires `running` and this predicate
 * refuses it, so both paths agree.
 */
export function isReviveableRetainedJob(job: RetainedJobView): boolean {
  if (job.statusUncertain) return false;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}
