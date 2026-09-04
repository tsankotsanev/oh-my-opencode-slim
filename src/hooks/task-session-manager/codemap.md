# src/hooks/task-session-manager/

## Responsibility

Manages V2 background job-board state for task execution and injected completion messages, enabling the orchestrator to track active jobs and reuse only completed, reconciled child sessions by short aliases (e.g., `exp-1`, `ora-2`). The implementation is split into focused submodules to improve separation of concerns and maintainability.

## Design

The directory follows a **Facade + Strategy** pattern where `index.ts` acts as the facade that composes and orchestrates behavior across specialized strategy modules:

- **index.ts**: Main facade that wires hooks into OpenCode's lifecycle and coordinates between the job board, pending calls, task context tracking, and explicit user waits. Implements the plugin hook interface (`tool.execute.before`, `tool.execute.after`, `experimental.chat.messages.transform`, `event`) and exposes `beginUserWait()` to the `wait_for_user` tool. It also owns the write side of lane control (`backgroundJobs.laneControl`, passed explicitly from `src/index.ts`; the option defaults OFF here so no test or embedded construction writes to the data dir): a debounced board mirror and server sidecar (`src/utils/lane-mirror.ts`, `src/utils/lane-control.ts`) flushed from the `event`/`tool.execute.after`/rehydration paths and disposed on `server.instance.disposed`, plus two intent claim paths: `claimUserStopIntent` (the event router attributes an abort to `omos lanes stop`) and a once-per-flush sweep that labels lanes which were ALREADY terminal when the user stopped them — those produce no abort event, so nothing else would ever claim their intent. It also registers its writers module-side (`claimLaneWriters`) so a factory re-run disposes the previous generation. It owns the cascade tracker too (`cascade-attribution.ts`, fed by the event router with child aborts, orchestrator aborts and managed-orchestrator busy/idle; disposed on `server.instance.disposed` AND in its own unconditional re-init teardown — `claimCascadeTracker`, NOT the `laneControl`-gated writer registry — because attribution runs regardless of lane control and a restart pending under `reviveOnCascade: 'auto'` must not fire after the user switched it off) and the third intent claim path, `claimUserReviveIntent`: a settled lane going busy with a `revive` line on disk is adopted through `revive-run.ts`, which registers the new generation with the revived-run tracker and labels the record `revivedByUser`, so a CLI revive ends up in exactly the state a `task_revive` would have produced.
- **cascade-attribution.ts**: Turns an abort of the orchestrator into an attribution, and optionally into a recovery. Abort cascades to the whole session tree (probes B1/B3) and carries no cause, so detection is two-sided: an anonymous child abort is a CANDIDATE, and a parent abort (unambiguous) or a parent idle confirms it — one candidate is enough when the parent was ALREADY idle when the lane died (the B3 signature), otherwise two siblings are required, because a busy parent goes idle ~0.7s after any unrelated child abort (B2). Unobserved parent liveness counts as busy (fail closed); stop-intent, `task_cancel` and wall-clock aborts never become candidates. TWO causes are attributed, both with the same blast radius and recovery but different wording (`CascadeCause`): `'esc'`, and `'fallback'` when foreground fallback aborted the orchestrator to re-prompt it on a fallback model — on a rate-limited provider the more common of the two. Only the parent-abort path can observe a cause; the idle rules are `'esc'` by construction, since a failover always produces the parent's own `session.error`. Confirmed lanes get the `killedByCascade` FIELD on their existing `error` record (never a new state) sharing one stamp per cascade, which is what makes the group addressable. `backgroundJobs.reviveOnCascade: 'auto'` (EXPERIMENTAL, default off) additionally resumes them 13s later via `revive-run.ts`, guarded by three gestures that actually work: the delay, a claimed post-cascade `omos lanes stop`, and a 10-minute per-lane cooldown (`lastAutoRevivedAt`, which survives kills). A second abort cancels earlier cascades' pending timers, but only while the parent is BUSY — aborting an already-idle parent emits no `session.error` (B3), so it is not a reliable gesture and the module header says so. One status read per cascade; only positively idle lanes are touched; the outcome is read THROUGH `reconciled` (a parent turn inside the window would otherwise hide every lane); at most once per lane per cascade, stamped before the prompt. Owns its own module-level per-directory generation registry (`claimCascadeTracker`), claimed UNCONDITIONALLY — unlike the lane writers, attribution runs regardless of `laneControl`, and a pending restart must not outlive the config update that turned `auto` off.
- **revive-run.ts**: The single relaunch mechanism, wrapped by `task_revive`, by cascade auto-revive, and by the adoption of a run `omos lanes revive` prompted from another process: relaunch lease → baseline message fence → optional prompt → `registerLaunch` (new generation) → `revivedRunTracker.register` → supervisor → immediate probe, with `markStatusUncertain` on failure. A held lease throws the typed `RelaunchLeaseUnavailableError` (the one transient failure, which `task_revive` renders as "cannot be revived" rather than "revive failed"). The baseline is what stops the tracker from reading the PREVIOUS run's last assistant message (which on an aborted lane carries `time.completed` AND an error) and publishing a false terminal; the adoption path computes its own by walking back over the in-flight assistant turn. Plugin-side resumes pin both the lane's `agent` and its live `model` or refuse.
- **revived-run-tracker.ts**: Synthesizes the `<task>` terminal notification for a REVIVED run, which produces no native `task` tool call and would otherwise leave the parent waiting forever (probe B2). The notification is DEFERRED when the router reports an abort (`holdNotification`, armed BEFORE `updateStatus` because the board relays terminals to its outcome listeners — `src/index.ts` registers this tracker as one — synchronously, so `onTerminal(record, { deferMs })` alone would already be too late) and rendered from the LIVE board record at send time, never the record captured when the abort landed: on an abort that record predates the cause by ~100ms. A lane the live record calls `killedByCascade` gets NO prompt at all — one abort produces N of them and the board already renders the group for free in a turn the orchestrator was taking anyway; a `cancelledByUser` lane still prompts, because a user's decision must not wait for the next turn.
- **stop-confirmation.ts**: Shared 5s grace for idle/absent runtime observations. Transient non-busy evidence stays provisional; confirmed durable stop evidence calls `markStopped` and can wake the parent. Busy/retry/live-busy reset the clock.
- **input-wait-tracker.ts**: Provides the single `hasInputWait()` seam used by idle reconciliation and continuation evaluation. It combines local question/permission waits with the process-global explicit user-wait latch. It is ORCHESTRATOR-scoped (`shouldManageSession`), so the child-side half of the HITL seam lives on the board instead: `event-router.ts` stamps `awaitingPermission` from a child's own `permission.asked` (core's in-process event; the SDK/HTTP translation `permission.updated` is accepted too, and the tool name is read from `permission` → `type` → `title`) and clears it on `permission.replied` (`requestID` first, then `permissionID`), which is what exempts a permission-blocked lane from silence detection and renders `Waiting: permission for <tool>`.
- **continuation-attempt-gate.ts**: Owns process-global continuation epochs, reservations, and explicit user waits across hook recreation. The wait is encoded as an `attempts` sentinel so pre-upgrade #856 hooks sharing the store also fail closed. Distinct external user-message identity rearms both states.
- **pending-call-tracker.ts**: Tracks in-flight task calls using a capped ordered map (`MAX_PENDING_TASK_CALLS`) to correlate launch output safely. Provides call ID generation, storage, retrieval, and cleanup for pending task invocations.
- **admission-runtime.ts**: Re-exports the per-directory admission runtime
  lease used by plugin generations; its scheduler and pending-call tracker are
  torn down only after the final unclaimed owner release.
- **task-context-tracker.ts**: Manages read context from child sessions with line-count and file caps. Stores context per task ID and provides pruning to prevent unbounded growth.

All modules depend on `BackgroundJobBoard` from `src/utils/background-job-board.ts` as the single source of truth for active jobs, terminal unreconciled jobs, reusable completed sessions, aliases, read context, and LRU caps.

### Key Abstractions

- **BackgroundJobBoard**: Central state store for task sessions (active, reusable, terminal unreconciled).
- **PendingTaskCall**: Tracks in-flight task invocations with call ID, parent session ID, agent type, label, and optional resumed task ID.
- **ContextFile**: Represents read context from child sessions with path, line numbers, and last-read timestamp.
- **User wait**: Explicit text-only HITL latch armed by `wait_for_user` and released by a distinct real external user message.

## Flow

### Task Execution Lifecycle

1. **Before Execution (`tool.execute.before`)**
   - Intercepts `task` tool calls on managed sessions
   - Generates a task label from `description`/`prompt` via `deriveTaskSessionLabel`
   - Creates a `PendingTaskCall` record with call ID, parent session ID, agent type, and label
   - Resolves reusable task IDs from the job board; completed/reconciled jobs
     are reusable by alias, while timed-out running jobs become recoverable
     only after a live busy signal confirms they are safe to resume
   - If no reusable task exists, allows fresh task creation
   - Refuses a brand-new spawn whose objective exactly matches an
     unreconciled terminal job from the same parent and agent (dispatch
     loop guard, #1070); a `task_result` retrieval after that job's
     completion (`lastUsedAt > completedAt`) authorizes the retry

2. **Task Launch (`tool.execute.after`)**
   - Registers task launches in the job board with task ID, parent session ID, agent type, and description
   - Parses task output to extract task ID, status, or launch information
   - Adds read context to the job board for completed or terminal unreconciled tasks
   - Handles late-cancelled tasks by normalizing output and updating state accordingly

3. **Context Tracking**
   - Extracts read files from `read` tool outputs using `extractReadFiles`
   - Stores context per task ID in the task context tracker
   - Prunes stale context during lifecycle events and status transitions

4. **Message Injection (`experimental.chat.messages.transform`)**
    - Injects a `<system-reminder>` part containing the `### Background Job Board` section into user messages for managed sessions
    - Lists active, unreconciled, and reusable sessions
    - Remembers injected terminal jobs to reconcile them on the next request after the completion was surfaced to the model (via `reconcileConsumedTerminalJobs`)
    - The idle timer remains a backstop for when the model ends its turn without further requests; after reconciling injected terminal results, the opt-in continuation evaluator can run in the same idle cycle under its existing guards

5. **Lifecycle Events (`event`)**
    - `session.created`: Adds new task IDs to pending managed set
    - `session.idle` / `session.status` (idle): Reconciles injected terminal jobs for the parent session (backstop path), then can run the opt-in continuation evaluator in the same idle cycle under its existing guards. Child idle is a stop candidate: the first observation stays provisional, and only a confirmed idle/absent after the 5s grace marks `stopped`
    - `session.status` (busy): Marks sessions as running from live session state and resets pending stop confirmation
    - `session.deleted`: Clears job state, child jobs, and pending call records for the session
    - `server.instance.disposed`: Clears generation-local state but leaves the
      shared pending calls and admission queue for the next generation

6. **Human-in-the-loop Waits**
   - `wait_for_user` calls the facade's `beginUserWait()` only after tool validation
   - The shared latch cancels pending continuation timers/reservations
   - Foreground-fallback replay provenance and shared fallback teardown state preserve the latch across plugin-manager recreation
   - Idle continuation remains suppressed until a distinct real user message arrives

### Data & Control Flow

```
User task call → tool.execute.before → PendingTaskCall created → task ID resolved/reused
→ tool.execute.after → BackgroundJobBoard.registerLaunch() → context extracted/added
→ Message transform → BackgroundJobBoard.formatForPrompt() injected as a system-reminder message part
→ session.idle → reconcileInjectedTerminalJobs() → BackgroundJobBoard.markReconciled()
→ opt-in continuation evaluator (same idle cycle, existing guards)
```

## Integration

### Consumers

- **Main Plugin (`src/index.ts`)**: Wires the task session manager hook into OpenCode's lifecycle via `createTaskSessionManagerHook()`.

### Dependencies

- **BackgroundJobBoard** (`src/utils/background-job-board.ts`): Central state store for task sessions and context.
- **Task Output Parsing Utilities** (`src/utils/index.ts`): `parseTaskIdFromTaskOutput`, `parseTaskLaunchOutput`, `parseTaskStatusOutput`, `deriveTaskSessionLabel`.
- **Guards & Logger**: `isRecord` utility and `log` for diagnostics.

### Configuration & Caps

- `maxSessionsPerAgent`: Limits reusable sessions per agent type
- `readContextMinLines`: Minimum lines to include in read context
- `readContextMaxFiles`: Maximum files to include in read context
- `shouldManageSession`: Predicate to determine which sessions are managed by this hook

### Events & Hooks

- `tool.execute.before` / `tool.execute.after`: Intercept task tool calls and register launches/status
- `experimental.chat.messages.transform`: Inject background job board status into user messages
- `event`: Handle session lifecycle events (created, idle, busy, error, deleted)

## Module Decomposition Rationale

The original monolithic module was split to improve:
- **Separation of Concerns**: Pending calls, task context, and job board state are now distinct responsibilities.
- **Testability**: Each module can be tested in isolation with focused contracts.
- **Maintainability**: Changes to one concern (e.g., context tracking) do not affect unrelated logic.
- **Scalability**: Capped data structures prevent unbounded memory growth.

Each submodule adheres to the **Single Responsibility Principle** while collaborating through the facade to provide a cohesive user experience.
