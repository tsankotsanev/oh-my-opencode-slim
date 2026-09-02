# Background Orchestration

Background orchestration is the default orchestration model for
oh-my-opencode-slim. It assumes native OpenCode background subagents are
available and changes the orchestrator from a primary worker into a scheduler.

The old model was:

```text
orchestrator works directly → delegates when useful → waits for result
```

The default background-orchestration model is:

```text
orchestrator plans → dispatches background specialists → monitors → reconciles → verifies
```

This is a clean rebuild, not a compatibility layer over the old blocking model.

---

## Runtime Requirement

Background orchestration requires an OpenCode release that includes native
background subagents, launched with background subagents
enabled:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

The task API and background-control tools are:

| Tool | Purpose |
|------|---------|
| `task(..., background: true)` | Start a specialist in the background and immediately return a task ID |
| hook-driven completion | OpenCode injects terminal background task results automatically |
| `task_status` | Check the status of a tracked task |
| `task_result` | Retrieve a tracked task's result |
| `task_message` | Queue a non-interrupting message and return `queued` |
| `task_cancel` | Stop a generation while retaining its session |
| `task_revive` | Resume a retained session with a new instruction |
| `wait_for_user` | Plugin-provided orchestrator tool that pauses automatic orchestrator wakes while the user performs external manual work |

If these are not available, the scheduler cannot use the default background
workflow. Configure the environment variable through the installer or use the
one-shot export above before starting OpenCode.

Use an OpenCode release that includes native background subagents and hook-driven completion; run `opencode --version` and update if background tasks are missing.

---

## Core Principle

The orchestrator is not the default implementation worker.

Its job is to:

- understand the user request,
- break work into dependent and independent units,
- choose the right specialist for each unit,
- schedule background work,
- track task IDs and states,
- avoid conflicting writes,
- integrate specialist results,
- run or route final verification,
- communicate concise progress and outcomes to the user.

Specialists do the work. The orchestrator manages the work.

---

## Execution Loop

Every non-trivial request follows this loop:

```text
Understand
  ↓
Plan dependency graph
  ↓
Dispatch independent specialists in background
  ↓
Track task IDs and ownership
  ↓
Continue only independent coordination work
  ↓
Wait for hook-driven completion
  ↓
Reconcile results and resolve conflicts
  ↓
Dispatch follow-up work if needed
  ↓
Verify
  ↓
Final response
```

The orchestrator should not act on assumptions from a still-running task. It can
continue scheduling independent work, but dependent work waits for terminal task
results.

---

## Scheduler Responsibilities

### 1. Build a dependency graph

Before dispatching agents, the orchestrator identifies:

- which questions must be answered before implementation,
- which tasks can run in parallel,
- which tasks must be sequential,
- which files or subsystems each writer owns,
- which outputs are needed for final verification.

This does not need to be a long plan. It should be just enough structure to
avoid wasted work and conflicting edits.

### 2. Dispatch background specialists

Independent work should be launched with background tasks:

```text
task(
  description="Search auth flow",
  subagent_type="explorer",
  background=true,
  prompt="Find the auth entry points, session storage, and login callback paths. Return file paths and a concise map. Do not edit files."
)
```

The orchestrator records the returned task ID and keeps working only on safe,
independent coordination.

### 3. Track ownership

The scheduler must prevent write conflicts.

Rules:

- Only one write-capable specialist owns a file at a time.
- Do not run two `fixer` tasks against overlapping folders unless ownership is
  explicit.
- UI work that touches shared components should not run beside implementation
  work that edits the same components.
- Review tasks can run in parallel with read-only discovery, but not with edits
  they are supposed to review.

### 4. Wait, message, cancel, and revive

Background tasks are not complete until OpenCode injects their terminal result or
hook-driven completion marks them terminal.

The orchestrator should use background completion events to:

- wait for dependent results,
- check long-running tasks,
- collect outputs before final response,
- surface failures or blocked tasks clearly.

Use `task_status` to inspect a task and `task_result` to collect its result.
`task_message` queues a non-interrupting message and returns `queued`; it does
not stop the current generation. Use `task_cancel` to stop a generation while
retaining its session, then inspect and reconcile any partial file changes before
launching replacement work. Use `task_revive` to resume a retained session with a
new instruction.

A cancelled or errored retained session may be revived immediately once its
retained state has been verified safe. Acknowledgement controls parent and
job-board consumption and reusable-pool display, not same-session revival.

Terminal jobs are reconciled automatically after their result is injected into
the orchestrator session. That lifecycle state is not proof the output was used;
the orchestrator must still verify it consumed the relevant result before
finalizing.

To stop self-reinforcing acknowledgment loops, a brand-new `task` spawn is
refused while the parent still owns an unreconciled terminal job with the same
agent and an exactly matching objective. The refusal names the existing task ID
and directs the caller to `task_result`; once that result has been retrieved,
the same objective may be dispatched again for follow-up work.

Separately, the default-on orchestrator wake scheduler may prompt an
idle parent with incomplete todos after continuous idle time; it does not depend
on the local job board.

After a full OpenCode or plugin restart, persisted running background-task
history is rehydrated into the local job board and immediately reconciled against
live host session status. A missing or idle child is a stop candidate: after a
5s confirmation grace it is surfaced as `stopped, unreconciled`, while a busy
child remains running; status lookup failures remain uncertain rather than being
treated as completion.

Specialist outputs are inputs, not final truth. The orchestrator reconciles them
against each other and the original user goal.

### 5. Verify

Verification remains orchestrator-owned and should be proportionate to the
change. Use focused checks against the final state, broadening them only when
risk or uncertainty warrants it. Oracle review is conditional: dispatch it for
material semantic or architectural risk, unresolved uncertainty, or another
high-cost decision—not automatically.

The final response should only happen after relevant background work is terminal,
reconciled, and supported by final-state evidence.

---

## Specialist Roles

### Explorer

Read-only reconnaissance and codebase mapping. Usually the first background task
for unfamiliar work.

### Librarian

External docs, version-specific API behavior, and real-world examples. Runs in
parallel with Explorer when implementation depends on current library behavior.

### Fixer

Bounded implementation worker. Receives a clear objective, file ownership,
constraints, and validation expectations.

### Designer

User-facing UI/UX implementation and review. Owns visual polish, responsive
layout, interaction quality, and design consistency.

### Oracle

Architecture, code review, simplification, risk analysis, and high-stakes
debugging. Often used after implementation or before risky refactors.

### Council

Multi-model decision support for critical trade-offs. It is not a worker pool;
it is for judgment where disagreement is useful.

### Observer

Visual/media analysis isolated from the orchestrator context.

---

## Direct Work Boundary

Background orchestration removes the orchestrator-as-worker default.

The orchestrator may directly:

- ask clarifying questions,
- read minimal context needed to route work,
- create and update todos,
- launch and monitor tasks,
- synthesize results,
- run final checks when that is cheaper than delegating.

The orchestrator should delegate:

- broad code search,
- unfamiliar library research,
- implementation,
- test creation or updates,
- UI polish,
- architecture review,
- visual/media analysis.

This keeps the main context focused on coordination instead of filling it with
worker detail.

---

## Task Prompt Contract

Every delegated task should be self-contained.

Include:

- objective,
- constraints,
- relevant files or search scope,
- ownership boundaries,
- expected output format,
- whether edits are allowed,
- validation to run or report,
- what not to do.

### Task-fit rejections

If a task is outside a specialist's role, it must not attempt partial work. It
returns a brief reason to the orchestrator.
The orchestrator treats that reason as routing input to reroute or clarify the
task and must not retry the unchanged task with the same specialist.

Good background task prompt:

```text
Investigate src/hooks/task-session-manager for assumptions that a task tool
result means the child task has finished. Do not edit files. Return:
1. exact files/functions involved,
2. which assumptions break with background tasks,
3. recommended code changes,
4. tests that should be added.
```

Bad background task prompt:

```text
Look into background tasks.
```

---

## State The Orchestrator Must Track

The prompt/runtime treats background tasks as a small job board:

| Field | Meaning |
|-------|---------|
| task ID | Native OpenCode background task/session ID |
| specialist | Agent type assigned |
| objective | What the task is responsible for |
| state | running; stopped (runtime ended without terminal task output); completed, error, or cancelled (explicit terminal task output); reconciled (terminal result consumed) |
| ownership | Files/folders/subsystems the task may edit |
| dependencies | Tasks that must complete first |
| result | Final task output once terminal |
| status certainty | `status uncertain` when the live status map is malformed or unavailable; it never implies completion |

Cancelled and errored sessions can remain retained for a later `task_revive`.
They may be revived immediately once their retained state has been verified safe.
Acknowledgement controls parent and job-board consumption and reusable-pool
display, not same-session revival.

The current todo list can represent user-visible work, but task IDs and file
ownership need to be explicit in the orchestrator's working context.

---

## Runtime Integration

The plugin is aware that a `task` return can mean "background job launched"
rather than "work complete". It tracks running task IDs, exposes recent work in
the background job board, updates aliases from task results, and keeps
multiplexer panes attached while the parent orchestrator continues scheduling.

### Orchestrator wake scheduler

When an orchestrator parent stays continuously idle, the plugin may send a
periodic internal wake prompt so incomplete TODOs are not abandoned. This is
**enabled by default** with a **5-minute** interval:

```jsonc
{
  "backgroundJobs": {
    "orchestratorWake": {
      "enabled": true,
      "intervalMs": 300000
    }
  }
}
```

`intervalMs` must be an integer from `60000` to `2147483647`. `0` is invalid.
Set `enabled: false` to disable wakes while keeping idle reconciliation and
background-job orchestration.

Behavior:

- Per-session recursive `setTimeout(...).unref()` after continuous parent-idle
  time (never a global interval).
- Only sessions known as the parent `orchestrator` via session metadata.
- Host client APIs are authoritative (`session.get`, `todo`, `children`,
  `status`, `promptAsync` with the nested directory request shape). The local
  Background Job Board is never read or used as a gate.
- Wake requires valid host response shapes, parent currently idle, and at least
  one TODO with status `pending` or `in_progress`. Unknown/malformed status
  fails closed. **Active children do not suppress a wake.**
- Suppress/clear on question/permission input waits, `wait_for_user`, foreground
  fallback, session busy, session deletion, external user messages, and server
  disposal.
- One in-flight evaluation/wake per session. Status/waits/generation are
  rechecked immediately before `promptAsync`. Cooldown/reservation is recorded
  before the call so a failed `promptAsync` cannot storm retries.
- Default-on safety: the scheduler evaluates a bounded host-progress fingerprint
  (TODO statuses plus child status/update evidence) to decide whether to keep
  waking. After **two** successful wakes with an unchanged fingerprint, further
  wakes stop for that continuous idle spell. A real external user message or
  host-observed progress re-arms the cap. Busy caused by the wake itself does
  **not** rearm the cap; unrelated busy/error lifecycle events do. The wake
  prompt text is static and does **not** include a fingerprint or snapshot.
- Static wake text (internal initiator part via `promptAsync` only — no message
  transform injection or history rewrite):

```text
<system-reminder>
Finish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.
</system-reminder>
```

The scheduler does **not** perform automatic cancellation and does not rely on
the local job board. When no incomplete TODOs remain, it ends the current idle
spell and stops polling until new activity.

**v2 availability:** the v2 shim lacks the required session APIs, so this
capability-gated feature remains inactive there.

For external manual work, the orchestrator first gives the user concrete steps,
then calls `wait_for_user` as its final tool action. This explicit signal covers
text-only HITL turns without attempting to infer intent from assistant prose. The
wait remains armed across hook/plugin recreation in the same process and is
cleared only by a distinct real external user message or genuine session
deletion. Re-observing the user message that preceded the wait, synthetic/internal
messages (including foreground-fallback replays), fallback teardown, session
errors, and idle/busy events do not clear it. Immediate choices, clarifications,
and pasted command output continue to use the `question` tool. If
`wait_for_user` is intentionally listed in `disabled_tools`, the orchestrator
uses the `question` tool as the blocking boundary instead.

### Background Job Board Injection

By default, each prompt uses the `latest` board strategy. The hook removes prior
metadata-tagged board messages and injects the current board snapshot, preserving
the existing strip-and-replace behavior.

For checkpoint-oriented workflows, opt in to the append-only strategy:

```jsonc
{
  "backgroundJobs": {
    "strategy": "checkpoint-compatible",
    "maxRetainedSnapshots": 20
  }
}
```

`checkpoint-compatible` preserves prior board snapshots and appends a snapshot
anchored after the current real-message tail only when the formatted board
changes. Once created, snapshots are replayed on every managed turn, including
turns with an internal initiator or an empty board; those turns do not create a
new snapshot. Re-running injection with an unchanged board does not create a
duplicate. This changes board message history only; task coordination, storage,
terminal reconciliation, and reusable-session behavior remain unchanged. The
retained snapshot cache is in memory, is limited to 20 snapshots per cache epoch,
and is reset when OpenCode reports a session boundary or a compacted/rebased
message history. `maxRetainedSnapshots` controls
the epoch size and accepts integers from 1 to 100 (default `20`). When a changed
snapshot would exceed the configured limit, all retained snapshots are discarded
and only the new current snapshot is kept. This intentionally creates one cache
miss at the epoch boundary, after which a fresh run of up to the configured limit
can accumulate. The cache is lost on plugin restart, so snapshots are not
restored beyond those present in the current OpenCode message history.

### Runtime Liveness Reconciliation

The job board is a local projection; OpenCode's live session-status map is the
liveness authority. After a tracked task launches, the plugin periodically
checks that single map for every board job still marked `running`, while normal
session events remain the fast path.

`busy` and `retry` confirm that a job is live and reset any pending stop
confirmation. An explicit `idle` state or an absent session in an otherwise
valid map is not immediately terminal: the first observation starts a 5s
confirmation grace and keeps the job `running, status uncertain`. Repeat
non-busy evidence after that grace records `stopped, unreconciled` rather than
`completed`: it means execution ended before a native terminal task result was
delivered, not that the task succeeded. Stopped sessions are never reusable and
stay visible to the parent for recovery. A later live `busy` observation can
revive an unreconciled stopped job. After the parent has been woken and the stop
acknowledged, stale busy cannot flip the job back to running. Only explicit
terminal task output proves completion, error, or cancellation.

Malformed status entries and failed status requests are surfaced as `status
uncertain`; they never prove that a job stopped or completed and do not confirm
a pending stop. Each observation is generation-aware, so a delayed response
cannot modify a relaunched task.

### Silence Detection

`busy` proves that OpenCode still considers a session mid-turn. It does not
prove that anything is happening. When a child's provider stream hangs — a
dropped connection is the common cause — the session stays `busy` forever
while emitting nothing, and no lifecycle event is ever produced for it. Left
alone, the reconciliation above would keep confirming that lane as live and the
orchestrator would wait indefinitely.

Silence detection closes that gap as an extension of the same 5s cycle: no
second poller, no new board state. Every message/part event on a tracked child
(`message.part.delta`, `message.part.updated`, `message.updated`, and a
`session.status busy` transition) refreshes that lane's activity clock. When the
reconciliation cycle then reads `busy` for a lane whose clock has not moved in
longer than `backgroundJobs.staleAfterMs` (default 5 minutes), the lane gets one
bounded `session.messages` probe and the verdict is recorded as
`running, status uncertain` with the reason `no activity for Ns while busy`.

The probe also yields a `Last seen` line on the board — an excerpt of the
lane's most recent assistant text plus its last tool call and message count —
so the parent can see what the lane was doing when it went quiet instead of
guessing from file diffs. That line contains no age or timestamp: the board is
rendered into the prompt, and a wall-clock value there would change the bytes
on every injection and silently defeat the provider prompt cache.

Three kinds of lane are silent by design and are never flagged:

- **Executing a tool.** Nothing at all is emitted between a tool part's
  `running` and `completed` updates, so a long `bash` or nested subagent call
  is byte-identical to a freeze. Any unfinished tool part in the last assistant
  message exempts the lane, subject only to an internal 30-minute backstop.
- **Waiting for a human.** A child blocked on a **permission prompt** is
  stamped `awaitingPermission` from its own `permission.asked` event (core's
  in-process name; the HTTP event stream calls the same thing
  `permission.updated`, and both are accepted) and is
  exempt for as long as the stamp stands; the board renders
  `Waiting: permission for <tool>` so the pause is legible instead of
  suspicious. The stamp is dropped on `permission.replied`, on any output from
  the lane (a missed reply therefore self-heals), and on every terminal
  transition, so it can never make the exemption permanent. OpenCode's own
  input-wait tracker is orchestrator-scoped, which is why the child-side half
  lives on the board record. Such a lane is usually also parked on a pending
  tool part, so the tool exemption covers it a second time.
- **Retrying a provider call.** `retry` is a healthy, self-resolving state; the
  lane genuinely has nothing to say until the retry lands, and the silence
  clock restarts when it does.

One case is flagged and is *advisory rather than a fault*: a model doing more
than `staleAfterMs` of **non-streamed reasoning** emits no parts either, so it
will eventually be reported as `status uncertain`. The `Last seen` excerpt makes
that easy to recognise (the lane's last text is a coherent partial thought, not
a truncated stream), and the flag is not terminal — the lane keeps running and
clears itself the moment it emits. Raise `staleAfterMs` if your models routinely
think for longer than the budget.

Recovery is never inferred from a `busy` reading, because for a silent lane
that reading *is* the freeze signature — only real output clears the flag,
along with its reason and captured excerpt. Messages written *into* a lane do
not count: prompting a hung child with `task_message` produces user-message
events, and treating those as progress would let a poke buy the lane another
full silence window. Only the lane's own output revives it. While the flag
stands its reason text is frozen at the transition rather than recounting the
seconds each cycle, and each lane is re-probed at most once per `staleAfterMs`.
A flagged lane is not terminal and is never reusable; it is a statement that
the outcome is unknown, which is exactly what a hung stream leaves behind.

`task_status` reads the same record, so its `possibly_stuck` field is exactly
this flag and its `idle_for_seconds` is exactly this activity clock. The tool
and the rendered board cannot disagree, and the tool inherits the exemptions
above instead of applying a second, blunter idle threshold of its own.

A child `session.error` carrying a transport fault (`ECONNRESET`, `ENOTFOUND`,
`ETIMEDOUT`, `EAI_AGAIN`, `ECONNREFUSED`, or a bare `fetch failed` /
`socket hang up` / timeout message) is recorded as `error` — like any other
child error — but with a summary that names the cause and refuses to call the
task failed: *"Child session lost its transport connection (fetch failed); the
task outcome is unknown."* The state stays `error` deliberately, because an
`error` record can be revived in place with `task_revive` on the same session,
whereas leaving the lane `running, status uncertain` would let the child's
follow-on idle drive it into `stopped` — which is not revivable and would lose
the transport cause along the way. Persistent auth/model errors (401/410) keep
their existing foreground-fallback deferral.

Both behaviours are configurable:

```jsonc
{
  "backgroundJobs": {
    "silenceDetection": true, // default; false disables probing entirely
    "staleAfterMs": 300000 // default 5 minutes, minimum 10s
  }
}
```

With `silenceDetection: false` no lane is ever probed or flagged for silence,
and the liveness reconciliation above behaves exactly as it did before.

### Background Task Concurrency

`backgroundJobs.concurrency` (disabled by default, see
[Configuration](configuration.md#background-job-management)) caps how many
native background tasks may run at once. Admission happens in the
`tool.execute.before` hook: a task waits for a slot before OpenCode creates
its child session. Queued requests are admitted in order, but requests whose
resolved cap is saturated are skipped in favor of admittable later requests.

Only the most specific configured cap applies to a task: a model cap wins
over a provider cap, which wins over the default cap. `0` means unlimited.
So `modelConcurrency: {"openai/gpt-4o": 10}` permits 10 concurrent
`openai/gpt-4o` tasks even when `defaultConcurrency` is lower; other OpenAI
models fall back to `providerConcurrency` (or the default) instead.

The scheduler keeps its accounting correct across two runtime events:
- A task that switches models mid-flight (foreground model fallback or a
  runtime `/model` change on the child session) moves its provider/model
  accounting to the new model instead of keeping the admission-time model.
- The scheduler is process-scoped, so a plugin re-init (the plugin factory
  re-runs on config updates) preserves both running slots and queued
  tickets. Deleting a parent orchestrator also releases its children's
  admission slots, so capacity is never leaked by recursive-delete ordering.

Sessions that are themselves managed tasks — a background subagent running
its own nested `task(..., background: true)` calls — are exempt from
admission. They already hold a slot while running, so waiting for a second
one would self-deadlock once the queue saturates.

Admission itself has no timeout. A running task that never reaches a terminal
state keeps its slot forever, and queued tasks as well as the orchestrator's
`task` calls block behind it. When you enable `concurrency`, pair it with the
opt-in wall-clock supervisor below so stalled tasks are eventually forced to
a terminal state and release their slots.

### Opt-in Wall-clock Supervisor

The plugin can apply a one-shot wall-clock deadline to native background task
child sessions. It is disabled by default:

```jsonc
{
  "backgroundJobs": {
    "wallClockTimeoutMs": 900000,
    "abortGraceMs": 10000
  }
}
```

This supervisor recognizes only an explicit `task(..., background: true)` call.
Foreground tasks and calls where `background` is omitted or `false` are not
supervised. The deadline begins at the first launch observation for the current
run. Duplicate `session.created`/tool-hook observations, busy activity, tool
activity, and liveness timestamps do not renew it. An explicit relaunch or reuse
starts a new run generation.

When the deadline wins a race with a real terminal transition, the board records
a persistent hard-deadline marker, marks cancellation as requested, starts the
bounded abort grace period, and issues exactly one native session abort. The
grace timer is independent of whether the SDK abort resolves, rejects, or hangs.
An error, cancellation, or child deletion during grace publishes one stable
timed-out terminal outcome. If no terminal confirmation arrives before grace
expires, the outcome is `error`, `timedOut: true`, and `statusUncertain: true`,
with a summary stating that abort was not confirmed.

Late completion, busy, retry, or error events cannot replace a published hard
timeout, and a hard wall-clock timeout is not recoverable through the existing
external task-wait timeout path. The timeout outcome remains visible to the
parent through the normal terminal-unreconciled Background Job Board flow; no
prompt or raw task-result rewrite is used. Timeout terminals also issue a
permanent logical pane-close intent so generic and cmux multiplexer paths do not
respawn a pane on late busy events.

`wallClockTimeoutMs` accepts `0` or integers from `60000` through `2147483647`;
`abortGraceMs` accepts integers from `1000` through `60000`. This feature is
wall-clock-only: no no-progress/plateau policy, foreground fallback, model swap,
session deletion retry, or worker-death guarantee is implied.

### Controlling lanes from a second terminal

Every question about a background lane normally costs an orchestrator turn: the
model is the only thing that can reach a child session. `omos lanes` removes
that cost by talking to the OpenCode server directly with the SDK, from any
other shell, for **zero tokens and zero model turns**.

```bash
omos lanes                              # what is running here?
omos lanes list --json                  # same, for scripts
omos lanes show fix-1 -n 5              # tail of a lane's transcript
omos lanes say fix-1 "also update the codemap"
omos lanes stop ora-2 --reason "wrong file set"
```

```bash
omos lanes revive --cascade             # resume the lanes the last ESC killed
omos lanes revive fix-1                 # resume one lane in its own session
```

Options: `--dir <path>` (project, default cwd), `--server <url>`,
`-n/--count`, `--reason`, `--cascade`/`--all` (revive only), `--force`,
`--json`. See [ESC and recovery](#esc-and-recovery) for what `revive` does and
when it refuses.

**How it finds things.** With `backgroundJobs.laneControl` on (the default) the
plugin writes two files per project under
`<XDG_DATA_HOME>/opencode/storage/oh-my-opencode-slim/background-jobs/`, keyed
by `sha256(canonical project dir)[:16]`:

| file | writer | reader | purpose |
|---|---|---|---|
| `<key>.json` | plugin | CLI | lane list (alias, agent, state, objective, `Last seen`, permission stamp) |
| `<key>.server.json` | plugin | CLI | which server owns this directory (url, pid, heartbeat) |
| `<key>.intents.jsonl` | CLI | plugin | why a lane was just stopped, or that a busy signal is a resume you asked for |

The direction of each arrow is a hard rule, and one of them deserves emphasis:

> **The mirror is not a truth source.** The plugin never reads it back. Live
> lanes are reconstructed from the orchestrator's own transcript (see
> [Startup Behavior](#startup-behavior) and `rehydrateHistoricalRunningTasks`),
> so the mirror is a convenience copy for a second process and may lag by up to
> a second — or by a whole plugin restart if the data directory is unwritable.
> That is why every command that *acts* on a lane re-checks the live server
> first, and why a stale mirror can never turn a running lane into a no-op.

If the plugin cannot determine its own URL in-process, set
`OMO_OPENCODE_SERVER_URL` in both shells (or pass `--server`).

**What it refuses, and why.** These commands can abort and prompt real
sessions, so they fail closed. `--force` overrides the safety refusals — never
the agent rule.

| Situation | Refusal | With `--force` |
|---|---|---|
| Selector is a known `parentSessionID` | Refused offline, naming the lanes that would die: aborting an orchestrator kills its whole session tree | Proceeds, and prints the blast radius (`kills 3 lanes (fix-1, exp-1, ora-1)`) |
| Raw `ses_…` the mirror never saw, `session.get` shows no `parentID` | Refused (use ESC in the TUI for a tree kill) | Proceeds, prints `is a top-level session` |
| Raw `ses_…` whose parentage cannot be read | Refused — unknown parentage fails closed | Proceeds without the check |
| Sidecar's directory ≠ target directory | **Hard refusal, never forceable**: a recycled port could put you in another project's sessions | still refused |
| Sidecar pid dead, or heartbeat older than 3 refresh intervals (6 min) | Treated as stale; asks for `--server` or a restart | n/a (pass `--server`) |
| `stop` on a lane that is not `busy`/`retry` on this server | Refused, and **no intent is written** | Abort is sent, but the result is reported as *"nothing may have happened"* and exits 1 — an idle session after an abort is indistinguishable from an untouched one |
| `stop` on a `stopped`/`error` lane the server confirms idle | Exit 0, `already stopped; recorded` — the abort is skipped, the cancellation is still recorded (and claimed by the plugin on its next mirror flush) | same |
| `say` to a `running` lane that is not busy *here* | Refused: prompting it could start a second concurrent turn on a session another server is mid-turn in (corruption class) | Sends anyway |
| `say` to a `running, status uncertain` lane | Warned, then sent — an idle reading is exactly what that flag means | Sends without the check |
| `say` to a `running` lane whose cancellation the orchestrator owns (`cancellationRequested`) | **Refused, never forceable**: a prompt racing an in-flight abort is guaranteed to disagree with it | still refused |
| `say` to a `stopped`/`error` lane | Refused: the session exists, but no reply will reach the orchestrator — `omos lanes revive` it (or ask for `task_revive`) instead | Sent with `noReply`, so the text is left in the transcript as a note for whoever resumes the lane, without starting a turn |
| `say` to a `completed`/`cancelled`/`reconciled` lane | Refused: it already produced its result | Same as above — a note, not a turn |
| `say` with no recorded agent | **Refused, never forceable**: a prompt without the session's own `agent` permanently rewrites that session to the default `build` agent | still refused |
| `say` when the lane's current model cannot be established | Refused, exactly as `task_message` does — see below | Sends unpinned, and says that the lane may be re-pinned to its agent's configured model |

`stop` writes its intent *before* aborting, because the plugin sees the
resulting `session.error(MessageAbortedError)` within milliseconds. It claims
that line and labels the record — `Stopped by: the user, from a second terminal
(omos lanes stop): <reason>` plus an `Action:` line telling the orchestrator not
to relaunch it unasked — so the cancellation reaches the model on its next turn
at no token cost. The label is exactly that: a label. The state stays whatever
the lifecycle recorded (`error` for an abort), which keeps the lane revivable in
place, and a cancellation the orchestrator itself owns (`task_cancel` holds a
cancellation lease) is never relabelled. Intent lines are claimed once, expire
after 60s for attribution, and are pruned after 10 minutes.

`stop` also verifies rather than assumes: an accepted abort that does not leave
the session idle within 5s exits 1 and says so. Its "the orchestrator will see
this on its next turn" is free for a first-generation lane (the board is
injected into a turn the model was taking anyway); a lane that had been REVIVED
is tracked by the revived-run tracker, which synthesizes a `<task>` notification
and therefore does start one short turn.

**`say` pins two identities, not one.** Passing the lane's own `agent` is the
better-known rule (probe A2: omit it and the session is rewritten to `build`),
but the model matters just as much and fails in the opposite direction. Core's
`createUserMessage` resolves `input.model ?? agent.model ?? currentModel(session)`,
so the agent's *configured* model outranks the session's *current* one: a body
carrying only `agent` moves a lane that foreground fallback had switched away
from its primary straight back onto it, variant reset included. `say` therefore
reads the lane's live model (`session.get`, falling back to the newest user
message) and pins it explicitly — and refuses to send if it cannot establish
one, which is the same rule `task_message` applies.

**Data at rest.** The mirror and sidecar hold lane aliases, agent names, session
ids, the task objective and the last progress excerpt, capped at 300 characters
per text field. That is the same class of content OpenCode itself already keeps
under `~/.local/share/opencode/storage` (full message logs included), in the
same user-owned directory tree, so lane control adds no new exposure — but it
is not encrypted either. Set `backgroundJobs.laneControl: false` to write
nothing at all.

**Multi-server caveat.** The sidecar is last-writer-wins. If two servers share
one project directory (a TUI plus an `opencode serve`), the file names whichever
started or refreshed last, and the other one's lanes are reachable only with an
explicit `--server`. This is why `say` insists a `running` lane be busy on the
server it is about to talk to.

Multiplexer panes are titled `fix-1 · <session title>` so a pane maps to the
same alias the board, `omos lanes` and `task_message` use.

Turning this off (`backgroundJobs.laneControl: false`) stops all three files
from being written or read; `omos lanes list` then explains that the mirror is
missing, and orchestration is otherwise unaffected.

### ESC and recovery

**What ESC does.** Pressing ESC in the TUI aborts the orchestrator session, and
OpenCode's abort cascades to the **whole session tree**: every background lane
the orchestrator owns dies with it. This happens from a busy parent *and* from
an idle one (probes B1/B3 in `docs/agents/subagent-probe-results.md`), it emits
no `session.deleted`, and the plugin cannot prevent it — it observes events, it
does not own the abort.

What survives is everything that matters: each lane's **session is intact**, so
it can be resumed in place with its full history, plan and tool log still in
context. What is missing from the raw events is the *cause* — an abort carries
none, so "the user pressed ESC" and "something aborted this one lane" arrive as
byte-identical events. The plugin reconstructs it.

**Attribution.** A child abort that nobody asked for becomes a *candidate*; a
later orchestrator abort or idle confirms the group. The rules, and why each
threshold exists:

| Evidence | Attributed? | Why |
|---|---|---|
| Orchestrator `session.error(MessageAbortedError)` within 3s of the death (before or after) | **Yes**, even for one lane | Probe B1: the parent's own abort is unambiguous. The children are aborted ~0.1s FIRST, so the window looks backwards as well as forwards |
| Parent went idle, and it was **already idle** when the lane died | **Yes**, one lane is enough | Probe B3: an idle parent that emits another idle has no other reason to. This is the realistic background topology |
| Parent was **busy** when the lane died, then went idle | Only with **two or more** sibling deaths in the window | Probe B2: a parent goes idle ~0.7s after an unrelated single-lane abort simply because its own turn ended |
| Parent liveness never observed | Treated as **busy** (two-lane rule) | Fail closed |
| Parent idled BEFORE the only death | **No** | That is the reverse of the B3 ordering, and not a cascade at all |
| The lane had a `omos lanes stop` intent, an orchestrator `task_cancel`, a wall-clock timeout, or a foreground-fallback abort | **Never** | Those deaths are already explained; a fallback abort is the plugin's own |

Attribution is a **label on the `error` record** (`killedByCascade`), never a
new state, and it is dropped if a deliberate cancellation lands afterwards. An
unattributed lane loses nothing except the group affordances: it is still
`error`, still says its session is intact, and is still revivable by name.

The board then reads, per lane, and once per group of two or more:

```text
- fix-1 / ses_… / fixer / error, unreconciled
  Objective: fix the parser
  Interrupted by: ESC on the orchestrator (one abort kills every lane)
  Action: interrupted by ESC on the orchestrator; session intact - resume via task_revive or `omos lanes revive fix-1`
- 3 lanes were interrupted together by one ESC on the orchestrator (fix-1, exp-1, ora-1); every session is intact. Resume them all with `omos lanes revive --cascade`, or one at a time with task_revive.
```

> **Known false positive.** Two per-pane ESCs on sibling lanes within three
> seconds, while their parent happens to finish its turn, produce exactly the
> evidence of one ESC on the parent. In the default `off` mode the consequence
> is a wrong label; in `auto` it is an unwanted restart, undone with `omos lanes
> stop`. Nested lanes (a lane that launched lanes) are only attributed through
> the parent-abort path, because no liveness is tracked for a non-orchestrator
> parent.

**Recovering by hand.** From the second terminal, at zero orchestrator turns:

```bash
omos lanes revive --cascade        # the lanes the last ESC killed
omos lanes revive fix-1            # one lane, by alias
omos lanes revive --all            # every interrupted lane in this project
```

`revive` performs the same operation `task_revive` does, and that is the point:
it resumes the lane **in its own session** (never a new one), writes a `revive`
intent before prompting, and the plugin claims that line when the resulting busy
signal arrives to register a new run generation with the revived-run tracker. So
the orchestrator is notified with a `<task>` result when the resumed lane
finishes, exactly as if it had run `task_revive` itself — which matters, because
nothing else ever tells it (probe B2).

Both identities are pinned on the resume prompt, or the command refuses: the
lane's own `agent` (omitting it rewrites the session to `build`) and its live
`model` (omitting it re-pins the lane to the agent's configured model and undoes
a foreground-fallback failover). The prompt itself is deliberately minimal — the
session still has everything — except for the one thing the lane cannot know:

> You were interrupted by an abort. Continue your original task from where you
> left off; your earlier instructions still stand. Before repeating any file
> edit or command you were in the middle of, re-check its current state first.
> Finish with the same final report format.

| Situation | `revive` behaviour |
|---|---|
| Lane is `busy`/`retry` on this server | **Refused, never forceable**: it was already revived, or it lives on another server and prompting here starts a second concurrent turn |
| Status unreadable | Refused (`--force` proceeds) — no prompting blind |
| Session returns 404 | Reported as gone: there is nothing to resume into, relaunch the task instead |
| Lane you stopped yourself | Excluded from `--cascade`/`--all`; revivable by explicit alias, which is the reversal of your own decision |
| Lane that finished normally | Refused: the resume text would be a lie; ask the orchestrator for `task_revive` with a real follow-up prompt |
| Selector is an orchestrator session | Refused, like `stop`/`say` — aborting it kills every lane |
| No recorded agent, or model unestablished | Refused (agent never forceable; model forceable with a warning) |

**Recovering automatically (experimental).** `backgroundJobs.reviveOnCascade:
"auto"` resumes the attributed lanes by itself, 13 seconds after the cascade,
through the same machinery. It is **off by default** and marked EXPERIMENTAL,
because a wrong attribution here restarts work instead of merely mislabelling
it. Four gestures keep ESC a panic button:

1. **the delay** — 3s window + 10s grace before anything moves;
2. **`omos lanes stop`** — after a cascade the lane is already dead and idle, so
   `stop` records the cancellation instead of aborting, and auto-revive claims
   that intent immediately before prompting and skips the lane (labelling it as
   your cancellation);
3. **a second ESC** — an orchestrator abort that opens a new cascade cancels the
   pending restarts of the earlier one. Pressing ESC twice means it;
4. **a 10-minute per-lane cooldown** — cancelling timers is not enough on its
   own, because a re-killed lane belongs to a *new* cascade; the cooldown is
   what closes the ESC → revive → ESC loop. It survives kills and relaunches,
   and it never applies to an explicit `omos lanes revive`.

On top of those, auto-revive takes one live status read and touches only lanes
that are positively idle, never a lane whose cancellation the orchestrator owns,
and at most once per lane per cascade — the attempt is stamped *before* the
prompt, so a restart that never comes back is not retried.

The wake scheduler is deliberately not involved: it wakes an idle orchestrator
on its own schedule, and gating it on lane state was rejected — recovery here is
about the lanes, not about interrupting the parent.

---

## Startup Behavior

The installer and docs configure background subagents as a requirement for the
default scheduler workflow. If background subagents are
unavailable, treat it as an environment or OpenCode-version issue rather than an
intentional V1 fallback:

```text
Background orchestration requires OpenCode background subagents.
Start OpenCode with:

OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

No automatic legacy fallback keeps the mental model clean.

---

## Example Flow

User asks:

```text
Make background subagents first-class in this plugin.
```

The orchestrator should do something like:

1. Create todos for discovery, design, implementation, docs, tests, and
   verification.
2. Launch Explorer in background to map task-session hooks and task lifecycle.
3. Launch Oracle in background only if the change has material semantic or
   architectural risk or unresolved uncertainty.
4. Continue by preparing the dependency graph and file ownership plan.
5. Wait for the launched specialists via hook-driven completion.
6. Dispatch Fixer to implement prompt/config/hook changes with clear ownership.
7. Dispatch a second Fixer for tests if file ownership is separate.
8. Wait for implementation results.
9. Reconcile the implementation and dispatch Oracle only if remaining risk or
   uncertainty makes independent review worthwhile.
10. Run proportionate checks against the final state.
11. Report final state.

At no point does the orchestrator become the main implementer.

---

## Success Criteria

Background orchestration is working when:

- the orchestrator launches independent specialists in background by default,
- task IDs are tracked until terminal state,
- dependent work waits for real task results,
- file ownership prevents concurrent write conflicts,
- final responses only happen after reconciliation and verification,
- users see faster progress on multi-step work,
- the orchestrator context stays focused on decisions instead of worker detail.

Background orchestration is not just "parallel agents." It is a
scheduler-centered operating model for OpenCode's native background subagents.
