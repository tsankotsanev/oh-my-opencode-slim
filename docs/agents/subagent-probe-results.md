# Subagent control — probe results

Empirical answers to four questions about opencode server semantics, gathered by
`scripts/probes/subagent-probes.ts`. These decide the design of the next two
subagent-control phases.

## Environment

| Item | Value |
| --- | --- |
| opencode binary | `~/.opencode/bin/opencode` — **1.18.26** (task brief said 1.18.25; `--version` reports 1.18.26) |
| SDK | `@opencode-ai/sdk` 1.4.3 (`createOpencodeClient({ baseUrl })`) |
| Server | **throwaway** `opencode serve --port 4919 --hostname 127.0.0.1`, launched from a fresh `mktemp -d` + `git init` project |
| Env flag | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` |
| Config isolation | `XDG_CONFIG_HOME` pointed at a temp dir so the user's global agents/plugins were **not** loaded. Auth lives in the data dir (`~/.local/share/opencode/auth.json`) and still resolved. |
| Model | `opencode-go/deepseek-v4-flash` (cheap, tool-capable) |
| Agents | core `build`/`plan` (primary), `explore`/`general` (subagent) + a temp-project `probe-sub` (`mode: "subagent"`) |

Isolation verified before running anything:

```
$ curl -s http://127.0.0.1:4919/session
[]
$ curl -s http://127.0.0.1:4919/experimental/capabilities
{"backgroundSubagents":true}
$ curl -s http://127.0.0.1:4919/experimental/tool/ids
["invalid","question","bash","read","glob","grep","edit","write","task",
 "webfetch","todowrite","websearch","skill","apply_patch"]
```

The user's live sessions ran on unrelated ports (61881/61910/63377, PIDs 9561/74226/74829)
and were never contacted. The probe script also hard-refuses to run if the target
server already has any sessions (override: `PROBE_ALLOW_DIRTY=1`).

**No probes were blocked.** Five providers were authenticated, so every probe
including the generation-dependent ones completed.

### Baseline: how a background subagent actually looks

The `task` tool (core) takes `background: boolean` and a `task_id` for resumption.
When called with `background: true` it returns immediately:

```
tool: task  status=completed
input:  {"description":"b3-abort-idle-parent","subagent_type":"probe-sub","background":true,
         "prompt":"Run this exact bash command: sleep 60 && ls -1 | wc -l — then report…"}
output: <task id="ses_f9de8ba62ffeTonii76eLYuTFd" state="running">
        <summary>Background task started</summary>
        <task_result>
        The task is working in the background. You will be notified automatically when it finishes.
        DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work…
        </task_result>
        </task>
metadata: {"parentSessionId":"ses_f9de8bfbcffehkZsA6QvSlGV7g",
           "sessionId":"ses_f9de8ba62ffeTonii76eLYuTFd",
           "background":true,"jobId":"ses_f9de8ba62ffeTonii76eLYuTFd","truncated":false}
```

Two structural facts that matter downstream:

- `jobId === sessionId === the child session id`. There is no separate job handle;
  the child session id *is* the job identity.
- The child is created with `parentID` set, title `"<desc> (@<agent> subagent)"`,
  and a permission ruleset that **denies `task` and `todowrite`** — background
  subagents cannot spawn further subagents.
- Once the parent's turn ends, **the parent goes `idle` while the child stays `busy`**.
  `GET /session/status` returns only the child as busy. Completion is later
  delivered to the parent as a synthetic `user` message (see A1).

---

## Probe A — prompting a running child session directly

### Setup

Parent session created via `POST /session`, then `prompt_async` with `agent: build`
instructing exactly one `task` call with `subagent_type: probe-sub`, `background: true`,
and a child prompt of `sleep 40 && ls -1 | wc -l`. Child discovered via
`GET /session/:parent/children` (also visible as `parentID` in `GET /session`).

### A1 — `agent` supplied explicitly

Exact call:

```ts
client.session.promptAsync({
  path: { id: childID },
  body: {
    model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    agent: "probe-sub",                       // the child's own agent
    parts: [{ type: "text", text: "Additional instruction: also report the current date." }],
  },
})
```

Raw evidence:

```
child  = ses_f9dece0a6ffesXxkw7i6v7r2L8  agent=probe-sub  title="a1-slow-count (@probe-sub subagent)"
status: parent=busy child=busy
promptAsync(child) -> HTTP 204  error=null
child agent: before=probe-sub  immediately-after=probe-sub
```

The child's message log afterwards — the injected message was **queued and then
processed** once the in-flight `bash` step finished:

```
[user]      id=msg_062131f78… text: "Run this exact bash command: sleep 40 && ls -1 | wc -l …"
[assistant] id=msg_062131fc4… finish="tool-calls"
   step-start / reasoning / text "\n\n"
   tool: bash status=completed input={"command":"sleep 40 && ls -1 | wc -l"}
   step-finish reason="tool-calls"
[user]      id=msg_06213229f… text: "Additional instruction: also report the current date."
[assistant] id=msg_06213c366… finish="stop"
   step-start
   text: "The command printed **5**.\n\nCurrent date: **Wed Sep 02 2026**"
   step-finish reason="stop"

injected message present in child log : true
child answered the injected question  : true
child agent after full turn           : probe-sub
```

Critically, the injected instruction **propagated into the result the parent
received**. The parent's synthetic completion message:

```
<task id="ses_f9dece0a6ffesXxkw7i6v7r2L8" state="completed">
<summary>Background task completed: a1-slow-count</summary>
<task_result>
The command printed **5**.

Current date: **Wed Sep 02 2026**
</task_result>
</task>
```

**Conclusion: YES** — a running background child accepts a direct
`promptAsync` (HTTP 204), queues it, processes it after the current step, its
`agent` field is unchanged, and the injected instruction changes what the parent
is told. This is a usable steering channel.

### A2 — `agent` OMITTED (bug P3)

Same setup, fresh child. `agent` deliberately left out of the body:

```ts
client.session.promptAsync({
  path: { id: childID },
  body: {
    model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    // agent omitted
    parts: [{ type: "text", text: "Additional instruction: also report the current date." }],
  },
})
```

Raw evidence:

```
child  = ses_f9dec1daaffecKR4yLMGtcRPLQ  agent=probe-sub  title="a2-slow-count (@probe-sub subagent)"
child agent BEFORE prompt: probe-sub
promptAsync(child, no agent) -> HTTP 204  error=null
child agent IMMEDIATELY after: build
child agent AFTER turn      : build
>> agent field CHANGED probe-sub -> build  <-- reproduces bug P3
```

Per-message agent attribution shows the session was genuinely re-homed, not just
mislabelled — the injected turn was served by `build`, with `build`'s prompt and
toolset, inside a session that is still a `probe-sub` subagent child:

```json
[
 { "id": "msg_06213e259…", "role": "user",      "agent": "probe-sub" },
 { "id": "msg_06213e269…", "role": "assistant", "agent": "probe-sub" },
 { "id": "msg_06213e381…", "role": "user",      "agent": "build" },
 { "id": "msg_06214847d…", "role": "assistant", "agent": "build" }
]
```

**Conclusion: YES, bug P3 reproduces.** Omitting `agent` silently rewrites
`session.agent` to the default primary (`build`) *immediately on accept* — before
generation starts — and it stays changed. `agent` must always be passed explicitly
when prompting an existing session.

---

## Probe B — abort cascade

SSE subscription (`GET /event` via `client.event.subscribe()`) was attached before
every abort. Timings below are relative to the abort call.

### B1 — `abort(parent)` while the parent is still busy

```
before abort: parent=busy child=busy
abort(parent) -> HTTP 200 body=true
+6s after abort: parent=idle child=idle
child stopped within 30s of parent abort: true (status=idle)
```

SSE — note the **child is aborted first**, parent 0.1s later:

```
+0.0s CHILD  session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.0s CHILD  session.status status={"type":"idle"}
+0.0s CHILD  session.idle
+0.1s CHILD  message.updated role=assistant finish=undefined
+0.1s PARENT session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.1s PARENT session.status status={"type":"idle"}
+0.1s PARENT session.idle
+0.2s PARENT message.updated role=assistant finish=undefined
```

### B3 — `abort(parent)` while the parent is IDLE and the child still running

This is the realistic background topology (parent finished its turn, detached
child still working), and a different code path from B1.

```
reached parent-idle/child-busy: true (parent=idle child=busy)
abort(idle parent) -> HTTP 200 body=true
+6s after abort: parent=idle child=idle
child stopped after aborting IDLE parent: true (status=idle)

+0.0s CHILD  session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.0s CHILD  session.status status={"type":"idle"}
+0.0s CHILD  session.idle
+0.1s CHILD  message.updated role=assistant finish=undefined
+0.1s PARENT session.status status={"type":"idle"}
+0.1s PARENT session.idle
```

`parent's <task> notifications (B3): (none)` — the parent is never told the
background job died.

**Conclusion: YES, abort cascades parent → child**, in both the busy-parent and
idle-parent cases. No `session.deleted` event is emitted; the cascade is
`session.error(MessageAbortedError)` + `session.status{idle}` + `session.idle`
on the child, then the parent.

### B2 — `abort(child)` only

```
before abort: parent=busy child=busy
abort(child) -> HTTP 200 body=true
+6s after abort: parent=idle child=idle
parent session still retrievable: true
parent's <task> notifications after child abort (B2): (none)
```

SSE — the child dies; the parent finishes its own turn normally (`finish="stop"`):

```
+0.0s CHILD  session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.0s CHILD  session.status status={"type":"idle"}
+0.0s CHILD  session.idle
+0.7s PARENT message.updated role=assistant finish="stop"
+0.7s PARENT session.status status={"type":"busy"}
+0.7s PARENT session.status status={"type":"idle"}
+0.7s PARENT session.idle
+0.7s PARENT session.updated
```

The parent's complete final log contains only three messages — the original user
prompt, the `task` tool call, and `"DONE"`. **No completion or failure
notification ever arrives.**

**Conclusion: NO upward cascade** — aborting a child leaves the parent fully
intact and able to continue. But the abort is **silent**: the parent never learns
its background job died, so it will wait forever for a notification that will
never come. Any supervisor must synthesise that notification itself.

---

## Probe C — subagent-mode agent as primary of a top-level session

`GET /agent` in the isolated project:

```
build(primary), compaction(primary), explore(subagent), general(subagent),
plan(primary), probe-sub(subagent), summary(primary), title(primary)
subagent-mode agents: ["explore","general","probe-sub"]
```

Tested with both the temp-project `probe-sub` and the core `explore`, creating a
session with **no `parentID`** and prompting it with that agent:

```
POST /session {agent:'probe-sub'} -> HTTP 200 id=ses_f9deafec9ffe86gbpdLaCId1tt agent=probe-sub
GET  /session/:id -> agent=probe-sub parentID=undefined
promptAsync(agent:'probe-sub') -> HTTP 204 error=null
[assistant] finish="stop"  text: "TOPLEVEL-OK"
GET  /session/:id after prompt -> agent=probe-sub
>> generation completed: true  | any message error: false

POST /session {agent:'explore'} -> HTTP 200 id=ses_f9deaeedcffexM95b2teuSqUXL agent=explore
GET  /session/:id -> agent=explore parentID=undefined
promptAsync(agent:'explore') -> HTTP 204 error=null
[assistant] finish="stop"  text: "TOPLEVEL-OK"
GET  /session/:id after prompt -> agent=explore
>> generation completed: true  | any message error: false
```

**Conclusion: YES** — the server does **not** enforce `mode: subagent` at the
session level. A subagent-mode agent can own and drive a parentless top-level
session; both `POST /session` and `prompt_async` accept it (200/204, no error),
and `GET /session/:id` reports that agent. `mode` is only a hint about where an
agent is *offered* (the `task` tool's agent menu / UI pickers), not a runtime
constraint.

---

## Probe D — telling "finished" from "aborted" in the message log

Reference **completed** background child (`sleep 5` task):

```
[assistant] id=msg_062152b79… finish="tool-calls"
   step-start / reasoning / tool: bash status=completed / step-finish reason="tool-calls"
[assistant] id=msg_0621545e0… finish="stop"
   step-start / text "The command printed `5`." / step-finish reason="stop"
```
```json
{ "finish": "stop", "error": null, "timeCompleted": 1788351957499,
  "stepFinishReasons": ["stop"],
  "partTypes": ["step-start","text","step-finish"] }
```

**Aborted** children — all three abort scenarios produced the identical signature:

```json
// B1 (aborted before any part streamed)
{ "finish": null,
  "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } },
  "timeCompleted": 1788352063424,
  "stepFinishReasons": [], "toolParts": [], "textParts": [], "partTypes": [] }

// B3 (aborted mid-tool)
{ "finish": null,
  "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } },
  "timeCompleted": 1788352089624,
  "stepFinishReasons": [],
  "toolParts": [ { "tool": "bash", "status": "completed" } ],
  "partTypes": ["step-start","reasoning","tool"] }
```

Discriminators, in order of reliability:

| Signal | Finished | Aborted | Usable? |
| --- | --- | --- | --- |
| `info.error.name` | absent | `"MessageAbortedError"` | **best — definitive** |
| `info.finish` | `"stop"` / `"tool-calls"` | absent (`null`) | **good** |
| trailing `step-finish` part | present | **never present** | **good** |
| `info.time.completed` | set | **also set** | **no — trap** |
| `tool` part `status` | `completed` | may still say `completed` | **no — trap** |
| part list | ends `text` + `step-finish` | truncated, may be empty | weak/heuristic |

Two traps worth calling out: `time.completed` is stamped on aborted messages too,
and a tool part interrupted mid-execution can still read `status: "completed"`.
Neither can be used to infer success.

"**Stalled**" is *not* distinguishable from the message log — a stalled child looks
exactly like a running one. It must be detected out-of-band via
`GET /session/status` (`{"type":"busy"}`) combined with a staleness clock over
`message.part.delta` / `message.updated` events or `info.time` timestamps.

**Conclusion: YES** — `info.error.name === "MessageAbortedError"` on the last
assistant message is a definitive abort marker; a present `info.finish` plus a
trailing `step-finish` part marks clean completion. Stalled requires out-of-band
status polling.

---

## Summary

| # | Question | Answer | Key evidence |
| --- | --- | --- | --- |
| A1 | Can you prompt a *running* background child directly, with `agent` set? | **YES** | HTTP 204; message queued then processed; `agent` unchanged; injected text reached the parent's `<task state="completed">` result |
| A2 | Does omitting `agent` clobber `session.agent`? (bug P3) | **YES — reproduced** | `probe-sub → build` immediately on accept; injected turn attributed to `build` |
| B1 | Does `abort(parent)` stop a running background child (busy parent)? | **YES** | child `session.error(MessageAbortedError)` at +0.0s, parent at +0.1s |
| B3 | Does `abort(parent)` stop the child when the parent is *idle*? | **YES** | same cascade; child idle within 6s |
| B2 | Does `abort(child)` affect the parent? | **NO** | parent completes its turn `finish="stop"`, stays retrievable |
| B2/B3 | Does the parent get told its background job died? | **NO** | `parent's <task> notifications: (none)`; parent log stays at 3 messages |
| C | Can a `mode: subagent` agent be primary of a top-level session? | **YES** | `POST /session` 200 + `prompt_async` 204 + `finish="stop"` for both `probe-sub` and `explore`; `parentID=undefined` |
| D | Can you tell finished vs aborted from the message log? | **YES** | `error.name === "MessageAbortedError"` + missing `finish` + missing `step-finish` |
| D | Can you tell *stalled* from the message log? | **NO** | requires `GET /session/status` + staleness clock |

### Design implications

1. **Steering a live subagent works** — inject via `promptAsync` on the child, but
   **always pass `agent` explicitly** or you silently convert the child into a
   `build` session (P3). Treat a missing `agent` as a bug, not a default.
2. **Injected instructions mutate the parent-visible result.** The child's final
   text becomes the `<task_result>`. Steering is therefore observable to the
   parent and must be designed with that in mind (good for course-correction,
   dangerous for silent side-channel notes).
3. **`abort(parent)` is a kill-tree**, including from an idle parent. There is no
   built-in way to abort only the parent while letting background children live.
4. **`abort(child)` is silent** — no upward notification. A supervisor that
   cancels a background job must synthesise the `<task>` completion/failure
   message into the parent itself, or the parent hangs waiting forever.
5. **`mode: subagent` is not a runtime guard.** Do not rely on the server to
   prevent a subagent from being used as a top-level primary; enforce it in our
   own layer if that matters.
6. **Use `error.name`, not `time.completed`,** to classify terminal state, and add
   an out-of-band staleness watchdog for the stalled case.
7. **`jobId === child session id`** — the child session id is the only handle you
   need to track, cancel, or steer a background subagent.

---

## Reproducing

```bash
cd "$(mktemp -d)" && git init -q .
mkdir -p xdgconfig/opencode
cat > opencode.json <<'JSON'
{
  "model": "opencode-go/deepseek-v4-flash",
  "permission": { "bash": "allow", "edit": "allow", "webfetch": "allow" },
  "agent": { "probe-sub": { "mode": "subagent", "description": "Probe subagent",
             "model": "opencode-go/deepseek-v4-flash" } }
}
JSON
XDG_CONFIG_HOME="$PWD/xdgconfig" OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true \
  opencode serve --port 4919 --hostname 127.0.0.1 &

cd /path/to/omo-slim
PROBE_BASE_URL=http://127.0.0.1:4919 PROBE_OUT=/tmp/probe-evidence.json \
  bun scripts/probes/subagent-probes.ts
```

Env knobs: `PROBE_BASE_URL`, `PROBE_PROVIDER`, `PROBE_MODEL`, `PROBE_SUBAGENT`,
`PROBE_PRIMARY`, `PROBE_ONLY` (e.g. `B`), `PROBE_OUT`, `PROBE_ALLOW_DIRTY`.
The script refuses to run against a server that already has sessions.
