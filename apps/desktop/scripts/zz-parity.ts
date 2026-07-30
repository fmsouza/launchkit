#!/usr/bin/env bun
/** TEMPORARY parity harness: drive one ACP harness through the real composition root. */
import type { CanonicalEvent } from "@spectrum/agent-events"
import { createAppContext } from "@spectrum/runtime-core"
import type { HarnessId, ModelId } from "@spectrum/types"

const HARNESS = (process.argv[2] ?? "claude") as HarnessId
const MODEL = (process.argv[3] === "-" ? undefined : process.argv[3]) as
  | ModelId
  | undefined
const PROMPT = process.argv[4] ?? "Reply with exactly: PONG"
const MODE = (process.argv[5] ?? "manual") as
  | "manual"
  | "auto-edits"
  | "plan"
  | "bypass"

const ctx = createAppContext()
const loaded = await ctx.config.load()
if (!loaded.ok) process.exit(1)
const proxyKey = ctx.genProxyKey()
const running = ctx.proxy.start({
  host: loaded.value.settings.proxyHost,
  port: ctx.proxyPort,
  proxyKey,
  config: loaded.value,
})
await ctx.runtime.writeProxyKey(proxyKey)

const input = await ctx.resolveLaunchInput({
  harnessId: HARNESS,
  ...(MODEL !== undefined ? { modelId: MODEL } : {}),
  cwd: process.cwd(),
})
console.log(
  `launch: ${input.command} ${JSON.stringify(input.args)} env=${JSON.stringify(Object.keys(input.env))}`,
)

const started = ctx.routingDriver.start({
  ...input,
  permissionMode: MODE,
  initialPrompt: PROMPT,
})
if (!started.ok) {
  console.error("START FAILED", started.error)
  process.exit(1)
}
const session = started.value
const events: CanonicalEvent[] = []
let approvals = 0
let questions = 0
session.onEvent((e) => {
  events.push(e)
  if (e.type === "approval-requested") {
    approvals++
    console.log(`APPROVAL: ${JSON.stringify(e.target)} -> allow`)
    session.respondApproval(e.requestId, "allow")
  }
  if (e.type === "question-requested") {
    questions++
    console.log(`QUESTION: ${JSON.stringify(e.prompt.questions[0]?.question)}`)
    session.respondQuestion(e.requestId, {
      selections: [{ questionIndex: 0, labels: [], freeText: "yes" }],
    })
  }
})

const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "turn-finished")) break
  await new Promise((r) => setTimeout(r, 250))
}

const counts = new Map<string, number>()
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
console.log("events:", JSON.stringify([...counts].sort()))
console.log(`approvals: ${approvals} | questions: ${questions}`)
for (const e of events.filter((x) => x.type === "runner-started"))
  console.log("runner-started:", JSON.stringify(e))
const text = events
  .filter((e) => e.type === "text-delta" && e.role === "assistant")
  .map((e) => (e.type === "text-delta" ? e.text : ""))
  .join("")
console.log("assistant:", JSON.stringify(text.slice(0, 300)))
const tools = events
  .filter((e) => e.type === "tool-call-started")
  .map((e) => (e.type === "tool-call-started" ? e.tool : ""))
console.log("tools:", JSON.stringify(tools))
console.log("usage:", JSON.stringify(events.find((e) => e.type === "usage")))
console.log(
  "turn-finished:",
  JSON.stringify(events.find((e) => e.type === "turn-finished")),
)

session.close()
running.stop()
ctx.closeDb?.()
