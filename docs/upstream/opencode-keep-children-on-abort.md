# Upstream issue draft — abort scope for background subagents

**Status: DRAFT. Not filed.** Target repo: `anomalyco/opencode`.
Everything below the `---` is the issue body, ready to paste.

Local context (do not paste): evidence comes from
`docs/agents/subagent-probe-results.md` (probes B1/B2/B3, opencode 1.18.26,
`@opencode-ai/sdk` 1.4.3) and the reproduction script
`scripts/probes/subagent-probes.ts`. The plugin-side workaround is
`src/hooks/task-session-manager/cascade-revive.ts` plus
`omo lanes revive` in `src/cli/lanes/`.

---

**Title:** Background subagents: allow aborting a session without killing its
children, and notify the parent when a child is aborted

## Summary

With `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, a session's abort has
two behaviours that make background subagents hard to build a supervisor on:

1. **`POST /session/:id/abort` on a parent kills the whole session subtree**,
   including when the parent is idle and the children are the only thing
   running. There is no way to abort just the parent's own turn.
2. **Aborting a child is completely silent to the parent.** No `<task>` result,
   no failure notification, nothing. A parent that is waiting on a background
   task waits forever.

Together these mean that interrupting a parent session also destroys every
background subagent it launched, and no notification of that ever reaches the
parent's message log. In practice we observe this from `ESC` in the TUI: the
lanes of the interrupted session all stop within ~0.2s. We have not read the
TUI's keybinding code, so treat "ESC aborts the session" as an observation of
the effect rather than a claim about the implementation — the API-level
behaviour below is what we measured directly.

We would like:

- an **abort scope option**, so a caller can abort one session's turn without
  cascading into children;
- a **`<task>` failure notification to the parent** when one of its background
  children is aborted, so the parent stops waiting.

## Environment

- opencode `1.18.26`
- `@opencode-ai/sdk` `1.4.3`
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
- Isolated throwaway project + `opencode serve` on a dedicated port; SSE
  (`GET /event`) subscribed before every abort.

## Reproduction and observed behaviour

### B1 — abort a BUSY parent that has a busy background child

```
before abort: parent=busy child=busy
POST /session/{parent}/abort -> 200 body=true
+6s: parent=idle child=idle
```

SSE, relative to the abort call — note the **child is aborted first**, the
parent 0.1s later:

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

### B3 — abort an IDLE parent whose background child is still running

This is the normal background topology: the parent finished its turn and is
waiting, the detached child is still working. It is also the case where the
cascade is most surprising, because the parent has no turn to interrupt.

```
reached parent-idle/child-busy: true (parent=idle child=busy)
POST /session/{parent}/abort -> 200 body=true
+6s: parent=idle child=idle

+0.0s CHILD  session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.0s CHILD  session.status status={"type":"idle"}
+0.0s CHILD  session.idle
+0.1s CHILD  message.updated role=assistant finish=undefined
+0.1s PARENT session.status status={"type":"idle"}
+0.1s PARENT session.idle
```

`parent's <task> notifications: (none)`.

Note also that the idle parent emits **no `session.error`** here — only a
status/idle pair, and it emits that idle although it was already idle — so
from the outside the two cascade shapes are not even the same event sequence.

### B2 — abort the CHILD only

```
before abort: parent=busy child=busy
POST /session/{child}/abort -> 200 body=true
parent session still retrievable: true
parent's <task> notifications after child abort: (none)

+0.0s CHILD  session.error  error={"name":"MessageAbortedError","data":{"message":"Aborted"}}
+0.0s CHILD  session.status status={"type":"idle"}
+0.0s CHILD  session.idle
+0.7s PARENT message.updated role=assistant finish="stop"
+0.7s PARENT session.status status={"type":"idle"}
+0.7s PARENT session.idle
```

There is **no upward cascade** — good — but the parent's complete final message
log contains only three entries: the original user prompt, the `task` tool
call, and its own reply. **No completion or failure notification for the
aborted child ever arrives.**

### Additional observations

- **No `session.deleted` is emitted** in any of the three cases. The aborted
  sessions survive intact and idle, and can be prompted again (with `agent`
  supplied) to continue where they left off. That is what makes recovery
  possible at all.
- The abort event carries **no cause**, so a deliberate user cancel of one
  lane and a whole-tree cascade are byte-identical from a plugin's point of
  view.

## Why this is a problem

Interrupting a session is the universal "stop talking" gesture, and users reach
for it to stop the *parent's* reply. With background subagents enabled, that
same gesture silently destroys minutes-to-hours of work in every background
lane, including lanes that were about to finish. There is no narrower gesture
available, and no confirmation.

Conversely, a supervisor that stops a single lane on purpose (a "cancel this
one task" affordance) cannot tell the parent what happened, so the parent's
plan is left permanently waiting on a task that will never report.

## What we would like

1. **Abort scope.** Either:

   ```
   POST /session/:id/abort?scope=self      # abort only this session's own turn
   POST /session/:id/abort?scope=tree      # current behaviour (default)
   ```

   or a config flag on the background-subagent feature, e.g.

   ```jsonc
   { "experimental": { "backgroundSubagents": { "keepChildrenOnAbort": true } } }
   ```

   `scope=tree` remaining the default keeps this fully backwards compatible.
   The TUI could then use `scope=self` for `ESC` (with `scope=tree` on a second
   press, or a modifier), which matches what users mean by the keystroke.

2. **A `<task>` failure notification to the parent when a child is aborted.**
   Whatever shape the terminal `<task>` result normally has, emitted with an
   aborted/cancelled outcome, so the parent's next turn sees "this background
   task ended without a result" instead of waiting forever. This is useful
   independently of (1) — it is the fix for B2.

Optional, smaller, and useful on their own:

3. **A cause on the abort.** Any discriminator on the `MessageAbortedError`
   (or a sibling event) distinguishing "this session was aborted directly" from
   "this session was aborted because an ancestor was" would let supervisors
   report the difference without inference.

4. **Consistent parent events between B1 and B3.** An idle parent emitting the
   same `session.error(MessageAbortedError)` as a busy one would make the
   cascade a single detectable shape.

## Current workaround (for context)

We are a plugin (`oh-my-opencode-slim`) supervising background lanes for an
orchestrator agent. We only observe events, so we cannot prevent the cascade —
only infer it and undo it. Cascade membership is reconstructed by correlating
anonymous child aborts with a nearby parent abort or redundant parent idle,
which is unavoidably heuristic: B1's child-first ordering forces it to work
retroactively, and B3's missing parent `session.error` leaves the idle-parent
case resting on that redundant idle. Recovery itself is just a
`session.promptAsync` back into the surviving session, which works only
because no `session.deleted` is emitted.

A scope flag would replace all of the inference with a correct answer, and a
child-abort notification would remove the need for a supervisor to synthesize
one.

Happy to provide the full probe script or run further experiments against a
patch.
