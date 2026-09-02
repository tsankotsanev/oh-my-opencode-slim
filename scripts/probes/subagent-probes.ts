#!/usr/bin/env bun
/**
 * Subagent control probes (EXPERIMENT, not production code).
 *
 * Answers four questions about opencode server semantics that decide the design
 * of the subagent-control phases:
 *
 *   A. Can you prompt a *running* child (background subagent) session directly?
 *      A1 - with `agent` supplied explicitly.
 *      A2 - with `agent` OMITTED (does the session's agent field get clobbered
 *           to the default primary? -> bug P3)
 *   B. Abort cascade: does aborting the parent stop a running background child?
 *      And does aborting only the child leave the parent alone?
 *   C. Can an agent whose mode is `subagent` drive a top-level (parentless)
 *      session as its primary agent?
 *   D. How do you tell "finished" from "aborted" from the message log alone?
 *
 * SAFETY: this script only talks to the base URL you give it. Point it at a
 * throwaway server, never at a server backing a live interactive session.
 *
 *   cd "$(mktemp -d)" && git init
 *   OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true \
 *     opencode serve --port 4919 --hostname 127.0.0.1
 *
 *   PROBE_BASE_URL=http://127.0.0.1:4919 bun scripts/probes/subagent-probes.ts
 *
 * Env:
 *   PROBE_BASE_URL   default http://127.0.0.1:4919
 *   PROBE_PROVIDER   default opencode-go
 *   PROBE_MODEL      default deepseek-v4-flash
 *   PROBE_SUBAGENT   subagent-mode agent name, default probe-sub
 *   PROBE_PRIMARY    primary agent to drive parents, default build
 *   PROBE_ONLY       comma list to restrict probes, e.g. "A,D"
 *   PROBE_OUT        optional path to dump raw evidence as JSON
 */

import { createOpencodeClient } from "@opencode-ai/sdk"

// ---------------------------------------------------------------- config

const BASE_URL = process.env.PROBE_BASE_URL ?? "http://127.0.0.1:4919"
const PROVIDER = process.env.PROBE_PROVIDER ?? "opencode-go"
const MODEL = process.env.PROBE_MODEL ?? "deepseek-v4-flash"
const SUBAGENT = process.env.PROBE_SUBAGENT ?? "probe-sub"
const PRIMARY = process.env.PROBE_PRIMARY ?? "build"
const ONLY = (process.env.PROBE_ONLY ?? "A,B,C,D")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

const MODELREF = { providerID: PROVIDER, modelID: MODEL }

const client = createOpencodeClient({ baseUrl: BASE_URL })

// ---------------------------------------------------------------- utils

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let indent = 0
function log(...args: unknown[]) {
  console.log("  ".repeat(indent) + args.map((a) => String(a)).join(" "))
}
function section(title: string) {
  indent = 0
  console.log("\n" + "=".repeat(78))
  console.log(title)
  console.log("=".repeat(78))
}
function sub(title: string) {
  indent = 1
  console.log("\n" + "-".repeat(70))
  console.log("  " + title)
  console.log("-".repeat(70))
}

/** Pretty-print any value, truncated, for evidence logs. */
function dump(label: string, value: unknown, max = 1400) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1)
  const clipped = text && text.length > max ? text.slice(0, max) + `\n… [+${text.length - max} chars]` : text
  log(`${label}:`)
  for (const line of String(clipped ?? "undefined").split("\n")) log("  " + line)
}

/** Raw evidence bundle, printed at the end and optionally written to disk. */
const evidence: Record<string, unknown> = {}
function record(key: string, value: unknown) {
  evidence[key] = value
}

/** Poll until predicate is true or timeout. Returns whether it succeeded. */
async function waitUntil(
  label: string,
  predicate: () => Promise<boolean>,
  { timeoutMs = 90_000, intervalMs = 1500 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  log(`!! timed out waiting for: ${label} (${timeoutMs}ms)`)
  return false
}

// ------------------------------------------------------- server helpers

async function statusMap(): Promise<Record<string, { type: string }>> {
  const res = await client.session.status({})
  return (res.data ?? {}) as Record<string, { type: string }>
}

async function statusOf(id: string): Promise<string> {
  const map = await statusMap()
  return map[id]?.type ?? "idle"
}

async function isBusy(id: string) {
  return (await statusOf(id)) === "busy"
}

async function getSession(id: string) {
  const res = await client.session.get({ path: { id } })
  return res.data as { id: string; agent?: string; parentID?: string; title?: string } | undefined
}

async function childrenOf(id: string) {
  const res = await client.session.children({ path: { id } })
  return (res.data ?? []) as Array<{ id: string; agent?: string; parentID?: string; title?: string }>
}

async function messagesOf(id: string) {
  const res = await client.session.messages({ path: { id } })
  return (res.data ?? []) as MessageWithParts[]
}

type Part = {
  type: string
  text?: string
  tool?: string
  reason?: string
  state?: { status?: string; input?: unknown; output?: unknown; metadata?: unknown }
}
type MessageWithParts = {
  info: {
    id: string
    role: string
    finish?: string
    error?: unknown
    agent?: string
    time?: { created?: number; completed?: number }
    tokens?: unknown
    cost?: number
  }
  parts: Part[]
}

async function createSession(body: Record<string, unknown>) {
  const res = await client.session.create({ body: body as never })
  return { status: res.response.status, data: res.data as { id: string; agent?: string } | undefined, error: res.error }
}

/** promptAsync -> returns the raw status so we can prove acceptance/rejection. */
async function promptAsync(id: string, body: Record<string, unknown>) {
  const res = await client.session.promptAsync({ path: { id }, body: body as never })
  return { status: res.response.status, error: res.error, data: res.data }
}

function textOf(part: Part) {
  return part.type === "text" ? (part.text ?? "") : ""
}

/** Compact one-line-per-part rendering of a message log — the core of probe D. */
function renderMessages(msgs: MessageWithParts[], maxTextLen = 240) {
  const out: string[] = []
  for (const m of msgs) {
    const i = m.info
    out.push(
      `[${i.role}] id=${i.id} finish=${JSON.stringify(i.finish)} error=${JSON.stringify(i.error)} completed=${JSON.stringify(i.time?.completed)}`,
    )
    for (const p of m.parts) {
      if (p.type === "text") out.push(`   text: ${JSON.stringify((p.text ?? "").slice(0, maxTextLen))}`)
      else if (p.type === "tool")
        out.push(
          `   tool: ${p.tool} status=${p.state?.status} input=${JSON.stringify(p.state?.input ?? null).slice(0, 160)}`,
        )
      else if (p.type === "step-finish") out.push(`   step-finish reason=${JSON.stringify(p.reason)}`)
      else out.push(`   ${p.type}`)
    }
  }
  return out.join("\n")
}

/** Structural fingerprint of a session's terminal state, for probe D. */
function terminalShape(msgs: MessageWithParts[]) {
  const assistants = msgs.filter((m) => m.info.role === "assistant")
  const last = assistants.at(-1)
  if (!last) return { hasAssistant: false }
  const stepFinishes = last.parts.filter((p) => p.type === "step-finish").map((p) => p.reason)
  const toolStates = last.parts.filter((p) => p.type === "tool").map((p) => ({ tool: p.tool, status: p.state?.status }))
  return {
    hasAssistant: true,
    lastAssistantID: last.info.id,
    finish: last.info.finish ?? null,
    error: last.info.error ?? null,
    timeCompleted: last.info.time?.completed ?? null,
    stepFinishReasons: stepFinishes,
    toolParts: toolStates,
    textParts: last.parts.filter((p) => p.type === "text").map((p) => (p.text ?? "").slice(0, 200)),
    partTypes: last.parts.map((p) => p.type),
  }
}

// ---------------------------------------------------------- SSE collector

type Captured = { at: number; type: string; sessionID?: string; props: unknown }

class EventTap {
  events: Captured[] = []
  private abort = new AbortController()
  private started = false

  async start() {
    const res = await client.event.subscribe({ signal: this.abort.signal })
    this.started = true
    void (async () => {
      try {
        for await (const ev of res.stream as AsyncGenerator<{ type: string; properties?: unknown }>) {
          const props = (ev.properties ?? {}) as Record<string, unknown>
          const info = props.info as Record<string, unknown> | undefined
          const sessionID =
            (props.sessionID as string | undefined) ??
            (info?.sessionID as string | undefined) ??
            (info?.id as string | undefined) ??
            (props.sessionId as string | undefined)
          this.events.push({ at: Date.now(), type: ev.type, sessionID, props })
        }
      } catch {
        /* stream closed */
      }
    })()
    await sleep(400) // let the subscription attach
    return this
  }

  stop() {
    if (this.started) this.abort.abort()
  }

  /** Events touching the given sessions, since a timestamp. */
  since(ts: number, ids: string[], opts: { types?: RegExp } = {}) {
    return this.events.filter(
      (e) =>
        e.at >= ts &&
        (!e.sessionID || ids.includes(e.sessionID)) &&
        (ids.includes(e.sessionID ?? "") || !e.sessionID) &&
        (!opts.types || opts.types.test(e.type)),
    )
  }

  /** Session-lifecycle-relevant events only, labelled by role. */
  lifecycle(ts: number, labels: Record<string, string>) {
    const ids = Object.keys(labels)
    return this.events
      .filter((e) => e.at >= ts)
      .filter((e) => e.sessionID && ids.includes(e.sessionID))
      .filter((e) => /^session\.|^message\.updated$/.test(e.type))
      .map((e) => {
        const props = e.props as Record<string, unknown>
        const info = props.info as Record<string, unknown> | undefined
        const extra =
          e.type === "session.status"
            ? ` status=${JSON.stringify(props.status ?? info?.status)}`
            : e.type === "session.error"
              ? ` error=${JSON.stringify(props.error ?? info?.error).slice(0, 200)}`
              : e.type === "message.updated"
                ? ` role=${info?.role} finish=${JSON.stringify(info?.finish)}`
                : ""
        return `+${((e.at - ts) / 1000).toFixed(1)}s ${labels[e.sessionID!]} ${e.type}${extra}`
      })
  }
}

// --------------------------------------------------- spawn a background child

const SLOW_TASK = (secs: number) =>
  `Run this exact bash command: sleep ${secs} && ls -1 | wc -l  — then report the number it printed.`

/**
 * Drive a primary agent to spawn a *real* background subagent via the core
 * `task` tool, then return both session ids. This is the authentic topology
 * (a task-registry-backed background job), not a hand-rolled parentID session.
 */
async function spawnBackgroundChild(label: string, secs: number) {
  const parent = await createSession({ title: `probe-${label}-parent` })
  const parentID = parent.data!.id
  log(`parent = ${parentID}`)

  const prompt =
    `Call the task tool exactly once with subagent_type="${SUBAGENT}", background=true, ` +
    `description="${label}", and prompt="${SLOW_TASK(secs)}". ` +
    `Do not do the work yourself. After the tool call returns, reply DONE.`

  const accepted = await promptAsync(parentID, { model: MODELREF, agent: PRIMARY, parts: [{ type: "text", text: prompt }] })
  log(`parent prompt_async -> HTTP ${accepted.status}`)

  let childID: string | undefined
  const ok = await waitUntil(
    `child of ${parentID} to appear`,
    async () => {
      const kids = await childrenOf(parentID)
      if (kids.length > 0) {
        childID = kids[0].id
        return true
      }
      return false
    },
    { timeoutMs: 90_000, intervalMs: 1200 },
  )
  if (!ok || !childID) throw new Error(`no background child appeared for ${label}`)

  const childInfo = await getSession(childID)
  log(`child  = ${childID}  agent=${childInfo?.agent}  title=${JSON.stringify(childInfo?.title)}`)
  return { parentID, childID, childInfo }
}

// ------------------------------------------------------------------ probe A

async function probeA(tap: EventTap) {
  section("PROBE A — prompt a RUNNING child (background subagent) directly")

  // ---- A1: prompt the running child WITH an explicit agent -------------
  sub("A1: promptAsync(child, { agent: '<child agent>' }) while child is BUSY")

  const a1 = await spawnBackgroundChild("a1-slow-count", 40)
  const agentBefore = (await getSession(a1.childID))?.agent
  const parentStatusWhileChildRuns = await statusOf(a1.parentID)
  const childStatusBefore = await statusOf(a1.childID)
  log(`status: parent=${parentStatusWhileChildRuns} child=${childStatusBefore}`)

  const injected = "Additional instruction: also report the current date."
  const t0 = Date.now()
  const res = await promptAsync(a1.childID, {
    model: MODELREF,
    agent: agentBefore ?? SUBAGENT,
    parts: [{ type: "text", text: injected }],
  })
  log(`promptAsync(child) -> HTTP ${res.status}  error=${JSON.stringify(res.error ?? null)}`)

  const agentAfterPrompt = (await getSession(a1.childID))?.agent
  log(`child agent: before=${agentBefore}  immediately-after=${agentAfterPrompt}`)

  await waitUntil("A1 child idle", async () => !(await isBusy(a1.childID)), { timeoutMs: 150_000 })
  await sleep(3000)

  const a1Msgs = await messagesOf(a1.childID)
  const sawInjected = a1Msgs.some((m) => m.info.role === "user" && m.parts.some((p) => textOf(p).includes(injected)))
  const finalText = a1Msgs
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) => m.parts.map(textOf))
    .join("\n")
  const processedInjected = /\b(202[4-9]|date|Wed|Mon|Tue|Thu|Fri|Sat|Sun)\b/i.test(finalText)

  dump("child message log (A1)", renderMessages(a1Msgs), 3000)
  log(`injected message present in child log : ${sawInjected}`)
  log(`child answered the injected question  : ${processedInjected}`)
  log(`child agent after full turn           : ${(await getSession(a1.childID))?.agent}`)

  // did the parent's background-task result absorb the injected instruction?
  const parentMsgs = await messagesOf(a1.parentID)
  const taskCompletion = parentMsgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts.map(textOf))
    .find((t) => t.includes("<task") && t.includes("state=\"completed\""))
  dump("parent's injected task-completion message (A1)", taskCompletion ?? "(none seen)", 900)

  record("A1", {
    parentID: a1.parentID,
    childID: a1.childID,
    parentStatusWhileChildRuns,
    childStatusBefore,
    promptStatus: res.status,
    promptError: res.error ?? null,
    agentBefore,
    agentAfterPrompt,
    agentAfterTurn: (await getSession(a1.childID))?.agent,
    injectedPresent: sawInjected,
    injectedProcessed: processedInjected,
    childLog: renderMessages(a1Msgs),
    parentTaskCompletionMessage: taskCompletion ?? null,
    events: tap.lifecycle(t0, { [a1.parentID]: "PARENT", [a1.childID]: "CHILD" }).slice(0, 40),
  })

  // ---- A2: prompt a fresh running child WITHOUT agent (bug P3) ---------
  sub("A2: promptAsync(child, { /* agent OMITTED */ }) — does session.agent get clobbered?")

  const a2 = await spawnBackgroundChild("a2-slow-count", 40)
  const a2Before = (await getSession(a2.childID))?.agent
  log(`child agent BEFORE prompt: ${a2Before}`)

  const t1 = Date.now()
  const res2 = await promptAsync(a2.childID, {
    model: MODELREF,
    // agent deliberately omitted
    parts: [{ type: "text", text: "Additional instruction: also report the current date." }],
  })
  log(`promptAsync(child, no agent) -> HTTP ${res2.status}  error=${JSON.stringify(res2.error ?? null)}`)

  const a2Immediately = (await getSession(a2.childID))?.agent
  log(`child agent IMMEDIATELY after: ${a2Immediately}`)

  await waitUntil("A2 child idle", async () => !(await isBusy(a2.childID)), { timeoutMs: 150_000 })
  await sleep(3000)
  const a2After = (await getSession(a2.childID))?.agent
  log(`child agent AFTER turn      : ${a2After}`)
  log(
    `>> agent field ${a2Before === a2After ? "UNCHANGED" : `CHANGED ${a2Before} -> ${a2After}`}` +
      `${a2After === PRIMARY && a2Before !== PRIMARY ? "  <-- reproduces bug P3" : ""}`,
  )

  const a2Msgs = await messagesOf(a2.childID)
  dump("child message log (A2)", renderMessages(a2Msgs), 2600)
  // which agent actually served the injected turn?
  const perMessageAgents = a2Msgs.map((m) => ({ id: m.info.id, role: m.info.role, agent: m.info.agent ?? null }))
  dump("per-message agent attribution (A2)", perMessageAgents, 900)

  record("A2", {
    parentID: a2.parentID,
    childID: a2.childID,
    promptStatus: res2.status,
    promptError: res2.error ?? null,
    agentBefore: a2Before,
    agentImmediatelyAfter: a2Immediately,
    agentAfterTurn: a2After,
    clobbered: a2Before !== a2After,
    clobberedTo: a2After,
    perMessageAgents,
    childLog: renderMessages(a2Msgs),
    events: tap.lifecycle(t1, { [a2.parentID]: "PARENT", [a2.childID]: "CHILD" }).slice(0, 40),
  })

  return { a1, a2 }
}

// ------------------------------------------------------------------ probe B

async function probeB(tap: EventTap) {
  section("PROBE B — abort cascade")

  // ---- B1: abort the PARENT while a background child is running --------
  sub("B1: abort(parent) with a running background child")

  const b1 = await spawnBackgroundChild("b1-abort-parent", 60)
  await waitUntil("B1 child busy", () => isBusy(b1.childID), { timeoutMs: 60_000 })
  const preParent = await statusOf(b1.parentID)
  const preChild = await statusOf(b1.childID)
  log(`before abort: parent=${preParent} child=${preChild}`)

  const t0 = Date.now()
  const abortRes = await client.session.abort({ path: { id: b1.parentID } })
  log(`abort(parent) -> HTTP ${abortRes.response.status} body=${JSON.stringify(abortRes.data)}`)

  await sleep(6000)
  const postParent = await statusOf(b1.parentID)
  const postChild = await statusOf(b1.childID)
  log(`+6s after abort: parent=${postParent} child=${postChild}`)

  const childStopped = await waitUntil("B1 child to stop", async () => !(await isBusy(b1.childID)), {
    timeoutMs: 30_000,
    intervalMs: 1500,
  })
  const finalChild = await statusOf(b1.childID)
  log(`child stopped within 30s of parent abort: ${childStopped} (status=${finalChild})`)

  const b1Events = tap.lifecycle(t0, { [b1.parentID]: "PARENT", [b1.childID]: "CHILD" })
  dump("SSE lifecycle events after abort(parent)", b1Events.join("\n") || "(none)", 2000)

  // keep this child's log for probe D (aborted case)
  const b1ChildMsgs = await messagesOf(b1.childID)
  dump("aborted child message log (B1)", renderMessages(b1ChildMsgs), 2200)

  record("B1", {
    parentID: b1.parentID,
    childID: b1.childID,
    preAbort: { parent: preParent, child: preChild },
    abortStatus: abortRes.response.status,
    abortBody: abortRes.data ?? null,
    postAbort6s: { parent: postParent, child: postChild },
    childStoppedWithin30s: childStopped,
    childFinalStatus: finalChild,
    events: b1Events,
    childLog: renderMessages(b1ChildMsgs),
    childTerminalShape: terminalShape(b1ChildMsgs),
  })

  // ---- B2: abort ONLY the child ---------------------------------------
  sub("B2: abort(child) only — is the parent affected?")

  const b2 = await spawnBackgroundChild("b2-abort-child", 60)
  await waitUntil("B2 child busy", () => isBusy(b2.childID), { timeoutMs: 60_000 })
  const b2PreParent = await statusOf(b2.parentID)
  const b2PreChild = await statusOf(b2.childID)
  log(`before abort: parent=${b2PreParent} child=${b2PreChild}`)

  const t1 = Date.now()
  const abort2 = await client.session.abort({ path: { id: b2.childID } })
  log(`abort(child) -> HTTP ${abort2.response.status} body=${JSON.stringify(abort2.data)}`)

  await sleep(6000)
  const b2PostParent = await statusOf(b2.parentID)
  const b2PostChild = await statusOf(b2.childID)
  log(`+6s after abort: parent=${b2PostParent} child=${b2PostChild}`)

  const parentAlive = (await getSession(b2.parentID)) !== undefined
  log(`parent session still retrievable: ${parentAlive}`)

  // does the parent still get a task-completion/failure notification?
  await sleep(8000)
  const b2ParentMsgs = await messagesOf(b2.parentID)
  const notif = b2ParentMsgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts.map(textOf))
    .filter((t) => t.includes("<task"))
  dump("parent's <task> notifications after child abort (B2)", notif.join("\n---\n") || "(none)", 1200)

  const b2Events = tap.lifecycle(t1, { [b2.parentID]: "PARENT", [b2.childID]: "CHILD" })
  dump("SSE lifecycle events after abort(child)", b2Events.join("\n") || "(none)", 2000)

  const b2ChildMsgs = await messagesOf(b2.childID)

  record("B2", {
    parentID: b2.parentID,
    childID: b2.childID,
    preAbort: { parent: b2PreParent, child: b2PreChild },
    abortStatus: abort2.response.status,
    abortBody: abort2.data ?? null,
    postAbort6s: { parent: b2PostParent, child: b2PostChild },
    parentStillRetrievable: parentAlive,
    parentTaskNotifications: notif,
    events: b2Events,
    childLog: renderMessages(b2ChildMsgs),
    childTerminalShape: terminalShape(b2ChildMsgs),
  })

  // ---- B3: abort an IDLE parent whose background child is still running ----
  // This is the REALISTIC background topology: the parent finishes its turn and
  // goes idle while the detached child keeps working. B1 aborted a *busy*
  // parent, which is a different code path.
  sub("B3: abort(parent) while parent is IDLE and background child still running")

  const b3 = await spawnBackgroundChild("b3-abort-idle-parent", 60)
  const settled = await waitUntil(
    "B3 parent idle while child busy",
    async () => {
      const map = await statusMap()
      const p = map[b3.parentID]?.type ?? "idle"
      const c = map[b3.childID]?.type ?? "idle"
      return p !== "busy" && c === "busy"
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  const b3PreParent = await statusOf(b3.parentID)
  const b3PreChild = await statusOf(b3.childID)
  log(`reached parent-idle/child-busy: ${settled} (parent=${b3PreParent} child=${b3PreChild})`)

  const t2 = Date.now()
  const abort3 = await client.session.abort({ path: { id: b3.parentID } })
  log(`abort(idle parent) -> HTTP ${abort3.response.status} body=${JSON.stringify(abort3.data)}`)

  await sleep(6000)
  const b3PostParent = await statusOf(b3.parentID)
  const b3PostChild = await statusOf(b3.childID)
  log(`+6s after abort: parent=${b3PostParent} child=${b3PostChild}`)

  const b3ChildStopped = await waitUntil("B3 child to stop", async () => !(await isBusy(b3.childID)), {
    timeoutMs: 40_000,
    intervalMs: 1500,
  })
  log(`child stopped after aborting IDLE parent: ${b3ChildStopped} (status=${await statusOf(b3.childID)})`)

  const b3Events = tap.lifecycle(t2, { [b3.parentID]: "PARENT", [b3.childID]: "CHILD" })
  dump("SSE lifecycle events after abort(idle parent)", b3Events.join("\n") || "(none)", 2000)

  const b3ChildMsgs = await messagesOf(b3.childID)
  dump("child message log (B3)", renderMessages(b3ChildMsgs), 1800)
  const b3ParentMsgs = await messagesOf(b3.parentID)
  const b3Notif = b3ParentMsgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => m.parts.map(textOf))
    .filter((t) => t.includes("<task"))
  dump("parent's <task> notifications (B3)", b3Notif.join("\n---\n") || "(none)", 900)

  record("B3", {
    parentID: b3.parentID,
    childID: b3.childID,
    reachedIdleParentBusyChild: settled,
    preAbort: { parent: b3PreParent, child: b3PreChild },
    abortStatus: abort3.response.status,
    abortBody: abort3.data ?? null,
    postAbort6s: { parent: b3PostParent, child: b3PostChild },
    childStopped: b3ChildStopped,
    childFinalStatus: await statusOf(b3.childID),
    parentTaskNotifications: b3Notif,
    events: b3Events,
    childLog: renderMessages(b3ChildMsgs),
    childTerminalShape: terminalShape(b3ChildMsgs),
  })

  return { abortedChild: b1.childID, abortedChild2: b2.childID, abortedChild3: b3.childID }
}

// ------------------------------------------------------------------ probe C

async function probeC() {
  section("PROBE C — subagent-mode agent as PRIMARY of a top-level session")

  const agents = ((await client.app.agents({})).data ?? []) as Array<{ name: string; mode?: string }>
  const byMode = agents.map((a) => `${a.name}(${a.mode})`).join(", ")
  dump("GET /agent", byMode, 1200)
  const subagentModes = agents.filter((a) => a.mode === "subagent").map((a) => a.name)
  log(`subagent-mode agents: ${JSON.stringify(subagentModes)}`)

  const results: Record<string, unknown> = { agentList: byMode, subagentModeAgents: subagentModes }

  for (const name of [SUBAGENT, "explore"].filter((n) => subagentModes.includes(n))) {
    sub(`C: top-level session driven by '${name}' (mode=subagent)`)

    // 1) create session WITHOUT parentID, asking for the subagent as its agent
    const created = await createSession({ title: `probe-c-${name}`, agent: name })
    log(`POST /session {agent:'${name}'} -> HTTP ${created.status} id=${created.data?.id} agent=${created.data?.agent}`)
    const id = created.data?.id
    if (!id) {
      results[name] = { createStatus: created.status, createError: created.error ?? null }
      continue
    }
    const afterCreate = await getSession(id)
    log(`GET /session/:id -> agent=${afterCreate?.agent} parentID=${JSON.stringify(afterCreate?.parentID)}`)

    // 2) promptAsync it with that subagent as the driving agent
    const pr = await promptAsync(id, {
      model: MODELREF,
      agent: name,
      parts: [{ type: "text", text: "Reply with exactly: TOPLEVEL-OK" }],
    })
    log(`promptAsync(agent:'${name}') -> HTTP ${pr.status} error=${JSON.stringify(pr.error ?? null)}`)

    await waitUntil(`C/${name} idle`, async () => !(await isBusy(id)), { timeoutMs: 90_000 })
    await sleep(2500)

    const msgs = await messagesOf(id)
    const after = await getSession(id)
    dump(`message log (C/${name})`, renderMessages(msgs), 1600)
    log(`GET /session/:id after prompt -> agent=${after?.agent}`)

    const produced = msgs.some((m) => m.info.role === "assistant" && m.parts.some((p) => textOf(p).includes("TOPLEVEL-OK")))
    const errored = msgs.some((m) => m.info.error)
    log(`>> generation completed: ${produced}  | any message error: ${errored}`)

    results[name] = {
      createStatus: created.status,
      createdAgent: created.data?.agent ?? null,
      agentAfterCreate: afterCreate?.agent ?? null,
      parentID: afterCreate?.parentID ?? null,
      promptStatus: pr.status,
      promptError: pr.error ?? null,
      agentAfterPrompt: after?.agent ?? null,
      generationSucceeded: produced,
      anyMessageError: errored,
      log: renderMessages(msgs),
      terminalShape: terminalShape(msgs),
    }
  }

  record("C", results)
}

// ------------------------------------------------------------------ probe D

async function probeD(abortedChildID: string | undefined) {
  section("PROBE D — telling 'finished' from 'aborted' in the message log")

  // a normally-completed child, for contrast
  sub("D: reference COMPLETED background child")
  const done = await spawnBackgroundChild("d-complete", 5)
  await waitUntil("D child idle", async () => !(await isBusy(done.childID)), { timeoutMs: 120_000 })
  await sleep(3000)
  const completedMsgs = await messagesOf(done.childID)
  const completedShape = terminalShape(completedMsgs)
  dump("COMPLETED child log", renderMessages(completedMsgs), 2000)
  dump("COMPLETED terminal shape", completedShape, 1600)

  let abortedShape: unknown = null
  let abortedLog = ""
  if (abortedChildID) {
    sub(`D: ABORTED background child (${abortedChildID}) — from probe B1`)
    const abortedMsgs = await messagesOf(abortedChildID)
    abortedShape = terminalShape(abortedMsgs)
    abortedLog = renderMessages(abortedMsgs)
    dump("ABORTED child log", abortedLog, 2000)
    dump("ABORTED terminal shape", abortedShape, 1600)
  } else {
    log("!! no aborted child available (probe B skipped)")
  }

  sub("D: discriminator summary")
  const c = completedShape as Record<string, unknown>
  const a = (abortedShape ?? {}) as Record<string, unknown>
  log(`completed: finish=${JSON.stringify(c.finish)} stepFinish=${JSON.stringify(c.stepFinishReasons)} error=${JSON.stringify(c.error)} completedAt=${JSON.stringify(c.timeCompleted)}`)
  log(`aborted  : finish=${JSON.stringify(a.finish)} stepFinish=${JSON.stringify(a.stepFinishReasons)} error=${JSON.stringify(a.error)} completedAt=${JSON.stringify(a.timeCompleted)}`)
  log(`aborted tool parts: ${JSON.stringify(a.toolParts)}`)

  record("D", {
    completedChildID: done.childID,
    completedShape,
    completedLog: renderMessages(completedMsgs),
    abortedChildID: abortedChildID ?? null,
    abortedShape,
    abortedLog,
  })
}

// ------------------------------------------------------------------- main

async function main() {
  section("SETUP")
  log(`baseUrl   = ${BASE_URL}`)
  log(`model     = ${PROVIDER}/${MODEL}`)
  log(`primary   = ${PRIMARY}   subagent = ${SUBAGENT}`)
  log(`probes    = ${ONLY.join(",")}`)

  // Safety: refuse to run against a server that already has sessions we didn't create.
  const existing = ((await client.session.list({})).data ?? []) as Array<{ id: string; title?: string }>
  log(`pre-existing sessions on server: ${existing.length}`)
  if (existing.length > 0 && process.env.PROBE_ALLOW_DIRTY !== "1") {
    log("!! server already has sessions. Refusing to run (set PROBE_ALLOW_DIRTY=1 to override).")
    log("!! This guard exists so probes never touch a live interactive server.")
    process.exit(2)
  }

  const caps = await fetch(`${BASE_URL}/experimental/capabilities`).then((r) => r.json())
  dump("GET /experimental/capabilities", caps, 400)

  const tap = await new EventTap().start()
  log("SSE tap attached to /event")

  let abortedChildID: string | undefined
  try {
    if (ONLY.includes("A")) await probeA(tap)
    if (ONLY.includes("B")) {
      const b = await probeB(tap)
      abortedChildID = b.abortedChild
    }
    if (ONLY.includes("C")) await probeC()
    if (ONLY.includes("D")) await probeD(abortedChildID)
  } finally {
    section("EVENT TAP SUMMARY")
    indent = 1
    const counts = new Map<string, number>()
    for (const e of tap.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    for (const [type, n] of [...counts.entries()].sort((x, y) => y[1] - x[1])) log(`${String(n).padStart(4)}  ${type}`)
    record("eventTypeCounts", Object.fromEntries(counts))
    tap.stop()
  }

  if (process.env.PROBE_OUT) {
    await Bun.write(process.env.PROBE_OUT, JSON.stringify(evidence, null, 2))
    section(`RAW EVIDENCE WRITTEN -> ${process.env.PROBE_OUT}`)
  }

  section("DONE")
}

await main()
