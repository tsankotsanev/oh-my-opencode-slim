# src/utils/

## Responsibility

Centralized utilities and shared abstractions used across the oh-my-opencode-slim plugin. This folder provides:
- Background job lifecycle management (board + store + coordinator + supervisor)
- Live session-status reads and session metadata tracking
- In-process opencode client access and client call-shape contracts
- Environment and configuration utilities
- Type guards and validation helpers
- Session and timeout utilities for council dispatch
- Logging infrastructure with automatic rotation
- Task output parsing utilities
- System message utilities, agent-variant/model helpers, and platform compat

## Design

### Core Abstractions

- **BackgroundJobBoard** (`background-job-board.ts`): Singleton registry and lifecycle manager for background tasks spawned by sub-agents. Implements a reusable session pool pattern with automatic cleanup and reconciliation hooks. Tracks task state (running, stopped, completed, error, cancelled), maintains context files, and provides prompt-ready summaries for agent coordination. Two advisory LABELS never change state: `awaitingPermission` (child-side HITL stamp; running lanes only, dropped on reply/activity/terminal, renders `Waiting: permission for <tool>`) and `cancelledByUser` (an `omos lanes stop` claimed on the lane's abort; refused when the orchestrator holds the cancellation, so `task_cancel` is never relabelled, and the terminal state stays whatever the lifecycle recorded so the lane is still `task_revive`-able). `stopped` records an ended runtime session without fabricated task success and is never reusable. Idle/absent observations start a 5s stop-confirmation grace (`stopConfirmationStartedAt`); live busy resets it. After a confirmed stop has been acknowledged, stale busy cannot reopen the job.

- **BackgroundJobStore** (`background-job-store.ts`): Atomic state-store contract (terminal transitions, leases, wall-clock deadline claims) implemented by the board; the single terminal-publication boundary.

- **BackgroundJobCoordinator** (`background-job-coordinator.ts`): Lifecycle policy layer between the board and its consumers — terminal-state subscriptions (replaces fire-and-forget), deferred-close policy, and prompt-metadata shaping.

- **BackgroundJobSupervisor** (`background-job-supervisor.ts`): One-shot wall-clock deadline supervision for background task runs: deadline timer → abort → grace timer → terminal finalization. Owns only timer/generation/abort mechanics.

- **BackgroundTaskConcurrency** (`background-task-concurrency.ts`): Process-local admission scheduler for native background tasks. Tracks queued tickets and active provider/model capacity without owning Job Board lifecycle state.

- **Runtime Session Status** (`session-runtime-status.ts`): Reads and validates the in-process OpenCode session-status map once per observation (5s bounded timeout). It distinguishes a valid absent session (`idle`) from malformed data or lookup failure (`unknown`) so lifecycle policy never treats schema drift as completion.

- **Session Metadata** (`session-metadata.ts`): `SessionMetadataStore` — bounded session → agent/directory map with LRU eviction that never evicts active orchestrator sessions.

- **Opencode Client** (`opencode-client.ts`): `getClient(input)` returns the in-process host client (no loopback HTTP, no caching).

- **Session Calls Contract** (`session-calls.contract.ts`): Type-only compile-time contract pinning the nested `{ path, query, body }` client call shapes and asserting the v2-flat shapes are rejected; compiled by `bun run typecheck`.

- **Prompt Agent** (`prompt-agent.ts`): Single source of truth for the `agent` field on plugin-initiated prompts. `resolveSessionAgent()` resolves the agent a session is running under (recorded hint → `session.get` → newest **user** message → fallback, only for a session confirmed/declared parentless) and `withAgent()` attaches it to a prompt body. An agent-less `session.prompt`/`promptAsync` body makes the runtime resolve its default primary and **permanently rewrite the session's agent** (`docs/agents/subagent-probe-results.md` probe A2), so `SYSTEM_AGENTS` (`compaction`/`summary`/`title`) are never derived, assistant messages are never trusted as hints, and plugin-created helper sessions use `FALLBACK_HELPER_SESSION_AGENT` (`build`) instead of `FALLBACK_TOP_LEVEL_AGENT` (`orchestrator`) so they are not adopted as managed orchestrator sessions. `prompt-agent.test.ts` scans all of `src/` and fails the build on any prompt call site that omits the field — with **no receiver-name filter**, since a `/session/i` heuristic previously hid `src/v2/client-shim.ts`'s own `s.prompt(` site (narrow, documented allowlists for the `promptWithTimeout` pass-through wrapper, the two v2 flat-host prompt files, and the type-only call contract). Probe reads accept an optional `directory` forwarded as `query.directory`, matching every other `session.get`/`session.messages` call site.

- **Session Error** (`session-error.ts`): Narrow classifiers for child-session errors — `isTransportError` (wire faults only: 5 transport codes plus the bare phrasings copied verbatim from foreground-fallback's `TRANSPORT_MESSAGE_PATTERNS`, with a drift test pinning the copy) plus a widened set of socket codes for lane classification, all pinned by a drift test that also asserts the extras stay disjoint from the mirror) so a lost wire can be reported with `transportSessionErrorReason` — an `error` record whose summary says the outcome is UNKNOWN, which stays `task_revive`-able in place — rather than as an opaque failure, `isAbortedSessionError` (`MessageAbortedError`), and `sessionErrorMessage`. Deliberately narrower than `isFailoverError`: rate limits and provider outages must stay `error`. The patterns are copied rather than imported because `src/utils` must not depend on `src/hooks`.

- **Continuation Model Selection** (`continuation-model-selection.ts`): `parseContinuationModelSelection` normalizes the two runtime model shapes (`{providerID, modelID}` from chat/prompt bodies, `{providerID, id}` from `Session.model`) into one pinnable selection. Shared leaf: the idle-continuation/wake paths, `task_message`, and the `omos lanes say` model pin all use it, so a host shape change is fixed in one place. (Moved here from `hooks/task-session-manager/` in Port B — `src/cli/` cannot import from `src/hooks/`.)

- **Lane Mirror** (`lane-mirror.ts`): Per-project JSON mirror of the board, written for the `omos lanes` CLI and **never read back by the plugin** (live lanes are rehydrated from the orchestrator's transcript; importing this file would resurrect pruned records and give two processes one mutable truth). Owns the vocabulary both sides share: the XDG data root (same convention as `src/companion/manager.ts`), `laneStateDir()`, `canonicalDirectory()` (realpath, so a symlinked `--dir` hashes identically), `laneStateKey()` = `sha256(dir)[:16]`, the narrow `LaneMirrorRecord` projection (lanes as an ARRAY — aliases are unique per parent only, so an alias-keyed object would drop a second orchestrator's lane), and `createLaneMirror()`: debounced to ≤1 flush/s, atomic tmp+rename, never throws, one final flush on dispose. A flush SKIPS the write when the serialized lanes are byte-identical to the last one (`savedAt` then keeps pointing at the last real change), because flushes are scheduled by events and most events touch no lane. `onBeforeFlush` is the once-per-second seam the hook uses to claim CLI stop intents for already-terminal lanes; free-text fields are capped at 300 chars and the permission request id is stripped. `claimLaneWriters`/`releaseLaneWriters` keep a module-level owner per canonical directory so a plugin re-init tears down the previous generation's mirror timer and sidecar heartbeat instead of racing it. Gated by `backgroundJobs.laneControl`; there is deliberately no `load()`.

- **Lane Control** (`lane-control.ts`): The other two lane-control artefacts. `createServerSidecar()` publishes `<key>.server.json` (url, canonical directory, pid, startedAt, heartbeat) at runtime start, refreshes it from the mirror flush (≥30s coalesce) and on a 120s unref'd timer, and REMOVES it on `server.instance.disposed` — a missing sidecar yields a clear message, a stale one would point the CLI at a dead or recycled port. `appendLaneIntent`/`readLaneIntents`/`consumeLaneIntent` implement the CLI→plugin `<key>.intents.jsonl` channel: append-only JSONL, 60s attribution window, 10-minute retention, 256 KB read cap, and a literal *claim* (the matched line is deleted) so a later event of the same kind cannot inherit the label. Two actions, one per direction of a user's mind: `consumeStopIntent` explains an abort, `consumeReviveIntent` explains the busy signal a `omos lanes revive` is about to cause (which is how the plugin knows to register that run with the revived-run tracker). It also owns `RESUME_PROMPT_TEXT`, the single resume prompt shared by the CLI and the plugin's auto-revive — it lives here because `src/cli/` cannot import from `src/hooks/`, and two copies of that text would be an invisible inconsistency.

- **Cascade stamp** (in `background-job-board.ts`): `CascadeCause` = `'esc' | 'fallback'` plus `CascadeStamp {parentSessionID, at, cause}` and `cascadeCauseLabel()`. `at` is the cascade's identity (shared by every member, which is what `--cascade` selects on); `cause` exists because an abort of the orchestrator has two producers with one blast radius — ESC, and this plugin's own rate-limit failover — and telling the orchestrator a keypress happened when its own recovery killed the lanes would be worse than saying nothing.

- **Lane State** (`lane-state.ts`): `isReviveableRetainedJob`, the one revivability predicate, structural so the board record and the narrow mirror record can both satisfy it. Re-exported by `src/tools/task-revive.ts` and used by the cascade auto-revive, the busy-signal adoption and `omos lanes revive`; a second copy would let the CLI accept a lane the tool refuses.

- **Server URL** (`server-url.ts`): How the plugin learns its own server URL, extracted from the multiplexer so the pane spawner, the lane sidecar and the CLI can never disagree. `validServerUrl`/`clientBaseUrl` (hostile-client safe) plus two resolvers: `createServerUrlResolver` (ctx.serverUrl → SDK client baseUrl) for the multiplexer and `createLaneServerUrlResolver` (adds `$OMO_OPENCODE_SERVER_URL`) for lane control — the multiplexer stays env-free because a wrong env value there would attach panes to another project's server.

- **Logger** (`logger.ts`): File-based logging with 7-day retention, automatic directory creation, and write queuing. Logs are written to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log` and cleaned up on initialization.

- **Session Utilities** (`session.ts`): Timeout handling, session abort coordination, model reference parsing, and session content extraction. Provides `promptWithTimeout` and `extractSessionResult` for safe session operations.

- **Task Utilities** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results from tool output strings. Used for resumption and status tracking.

- **Type Guards** (`guards.ts`): Simple type checking utilities (`isRecord`) for runtime validation.

- **Environment Utilities** (`env.ts`): Environment variable parsing and plugin disable flag checking.

- **Internal Initiator** (`internal-initiator.ts`): Marker system for identifying internally-initiated agent messages to prevent infinite loops.

- **System Collapse** (`system-collapse.ts`): Utility for collapsing multiple system messages into a single entry by joining with double-newlines.

- **Agent Variant** (`agent-variant.ts`): `normalizeAgentName` (`@`-strip/trim) and `escapeRegExp` for display-name rewriting.

- **Councillor Models** (`councillor-models.ts`): Pure helpers resolving councillor model fallback chains without pulling zod/schema into runtime consumers.

- **Polling** (`polling.ts`): Generic `poll()` helper with interval/max-time/stable-threshold/abort options.

- **Compat & Zip** (`compat.ts`, `zip-extractor.ts`): `crossSpawn` (cross-platform spawn with stdout/stderr collection) and `extractZip` (Windows-aware tar/pwsh fallbacks).

- **Misc** (`escape-html.ts`, `frontmatter.ts`): HTML escaping (interview UI) and frontmatter parsing (interview documents).

### Design Patterns

- **Singleton**: BackgroundJobBoard is a singleton registry with global state for all background tasks
- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking the main thread
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Background Job Lifecycle
1. Agent launches a background task via BackgroundJobBoard.registerLaunch() (supervisor arms the wall-clock deadline)
2. Task runs and updates status via BackgroundJobBoard.updateStatus()
3. On completion/error/cancellation, task is marked terminal and added to reusable pool; supervisor timers are cleared
4. Subsequent tasks from same agent/session can reuse completed sessions via aliases
5. Unused reusable sessions are automatically trimmed based on maxReusablePerAgent
6. A deadline exceeded while running → coordinator claims it, supervisor aborts the session, and a grace timer finalizes the terminal state

### Logging Flow
1. Plugin initializes logger with session ID via initLogger(sessionId)
2. Logs are appended to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log`
3. Old logs (>7 days) are automatically cleaned up on initialization
4. Log writes are queued to avoid blocking. File logging falls back to stderr after initialization failure or a write failure in the active generation; stale queued writes cannot replace a newer sink

### Session Operations
1. Council dispatch uses `promptWithTimeout()` to send prompts with configurable timeout
2. On timeout, session is aborted and OperationTimeoutError is thrown
3. Results are extracted via `extractSessionResult()` which collects all assistant message text

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses BackgroundJobBoard for background task management
  - Uses session utilities for prompt timeout and session extraction
  - Uses logger for debug and audit logging

- **Multiplexer** (`src/multiplexer/`):
  - Uses session utilities for session operations
  - Uses logger for session lifecycle events

- **Agents** (`src/agents/`):
  - BackgroundJobBoard for launching and tracking background tasks
  - Logger for agent-specific logging

- **Main Plugin** (`src/index.ts`):
  - Exports all utilities via `src/utils/index.ts`
  - Uses logger for plugin lifecycle events

### Dependencies

- **Node.js built-ins**: `fs`, `fs/promises`, `os`, `path` for logging and file operations
- **@opencode-ai/sdk**: PluginInput type for session utilities

### Export Chain

`src/utils/index.ts` re-exports all utilities, providing a single entry point:
```typescript
export * from './agent-variant';
export * from './background-job-board';
export * from './background-job-coordinator';
export * from './background-job-store';
export * from './background-job-supervisor';
export * from './internal-initiator';
export { initLogger, log } from './logger';
export * from './polling';
export * from './session';
export * from './session-runtime-status';
export * from './task';
export { extractZip } from './zip-extractor';
```

This allows consumers to import from `src/utils` rather than individual files.
Session metadata, the opencode client accessor, the prompt-agent and
session-error helpers, and the type-only call-shape contract are intentionally
imported directly from their modules (not re-exported): prompt call sites
should name `src/utils/prompt-agent` explicitly so the regression scan and its
allowlist stay easy to audit.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API re-exporting most utilities |
| `agent-variant.ts` | Agent name normalization and regex escaping |
| `background-job-board.ts` | Background task registry and lifecycle manager |
| `background-job-coordinator.ts` | Lifecycle policy and terminal-state subscriptions |
| `background-job-store.ts` | Atomic store contract and terminal transitions |
| `background-job-supervisor.ts` | Wall-clock deadline supervision and abort grace |
| `compat.ts` | Cross-platform spawn with output collection |
| `councillor-models.ts` | Councillor model fallback chain helpers |
| `env.ts` | Environment variable utilities |
| `escape-html.ts` | HTML escaping helper |
| `frontmatter.ts` | Frontmatter parsing for interview documents |
| `guards.ts` | Type guard utilities |
| `internal-initiator.ts` | Internal agent message marker system |
| `logger.ts` | File-based logging with rotation |
| `opencode-client.ts` | In-process host client accessor |
| `polling.ts` | Generic poll helper |
| `prompt-agent.ts` | Resolves a session's current agent and attaches it to prompt bodies (prevents the default-`build` session rewrite); guarded by a repo-wide scan test |
| `session-calls.contract.ts` | Compile-time client call-shape contract (type-only) |
| `session-error.ts` | Transport-fault / abort / message classifiers for session errors |
| `session-metadata.ts` | Bounded session → agent/directory store |
| `session-runtime-status.ts` | Bounded live session-status map reads |
| `session.ts` | Session timeout, abort, and extraction utilities |
| `system-collapse.ts` | System message collapsing utility |
| `task.ts` | Task output parsing utilities |
| `zip-extractor.ts` | Cross-platform zip extraction |
