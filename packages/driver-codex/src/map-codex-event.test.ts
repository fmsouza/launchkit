import { describe, expect, it } from "bun:test"
import type { CanonicalEvent, RunnerId } from "@spectrum/agent-events"
import * as fx from "./fixtures/codex-events"
import { type CodexMapState, mapCodexEvent } from "./map-codex-event"

const root = "rnr_root" as RunnerId
const freshState = (): CodexMapState => ({
  rootRunnerId: root,
  messageIds: new Map(),
  callIds: new Map(),
  runnerIds: new Map(),
  newRunnerId: () => "rnr_child" as RunnerId,
  newCallId: (() => {
    let n = 0
    return () => `call_${++n}`
  })(),
  nextMessageId: (() => {
    let n = 0
    return () => `msg_${++n}`
  })(),
})

describe("mapCodexEvent — thread/turn lifecycle", () => {
  it("maps thread/started to nothing extra (root runner-started is emitted by the adapter on start)", () => {
    const out = mapCodexEvent(fx.threadStarted, freshState())
    expect(out).toEqual([])
  })

  it("maps turn/started to nothing (the root runner is already running)", () => {
    expect(mapCodexEvent(fx.turnStarted, freshState())).toEqual([])
  })

  it("maps turn/completed (status completed) to turn-finished (the session stays alive for the next turn)", () => {
    const out = mapCodexEvent(fx.turnCompleted, freshState())
    expect(out).toEqual([
      { type: "turn-finished", runnerId: root },
    ] satisfies CanonicalEvent[])
  })

  it("maps turn/completed (status failed) to the error as assistant text + turn-finished (not session end)", () => {
    const out = mapCodexEvent(fx.turnFailed, freshState())
    expect(out).toEqual([
      {
        type: "text-delta",
        runnerId: root,
        messageId: "msg_1",
        text: "⚠️ boom",
      },
      { type: "turn-finished", runnerId: root },
    ] satisfies CanonicalEvent[])
  })

  it("maps turn/completed (status interrupted) to turn-finished", () => {
    const out = mapCodexEvent(fx.turnInterrupted, freshState())
    expect(out).toEqual([
      { type: "turn-finished", runnerId: root },
    ] satisfies CanonicalEvent[])
  })

  it("maps thread/tokenUsage/updated to a usage event on the root with mapped token counts", () => {
    const out = mapCodexEvent(fx.tokenUsage, freshState())
    expect(out).toEqual([
      {
        type: "usage",
        runnerId: root,
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 5 },
      },
    ] satisfies CanonicalEvent[])
  })

  it("ignores a retryable error notification", () => {
    expect(mapCodexEvent(fx.errorRetryable, freshState())).toEqual([])
  })

  it("maps a non-retryable error notification to runner-finished(errored)", () => {
    const out = mapCodexEvent(fx.errorFatal, freshState())
    expect(out).toEqual([
      {
        type: "runner-finished",
        runnerId: root,
        status: "errored",
        error: "fatal",
      },
    ] satisfies CanonicalEvent[])
  })
})

describe("mapCodexEvent — message + reasoning deltas", () => {
  it("assigns a stable canonical messageId per agentMessage item on item/started", () => {
    const state = freshState()
    mapCodexEvent(fx.agentMsgStarted, state) // registers it_msg -> msg_1 (emits nothing)
    const out = mapCodexEvent(fx.agentMsgDelta, state)
    expect(out).toEqual([
      { type: "text-delta", runnerId: root, messageId: "msg_1", text: "Hello" },
    ] satisfies CanonicalEvent[])
  })

  it("registers an agentMessage item/started without emitting", () => {
    const state = freshState()
    expect(mapCodexEvent(fx.agentMsgStarted, state)).toEqual([])
  })

  it("maps an agentMessage delta with no prior item/started by minting a messageId on demand", () => {
    const out = mapCodexEvent(fx.agentMsgDelta, freshState())
    expect(out).toEqual([
      { type: "text-delta", runnerId: root, messageId: "msg_1", text: "Hello" },
    ] satisfies CanonicalEvent[])
  })

  it("maps item/reasoning/textDelta to a reasoning-delta keyed by the reasoning itemId", () => {
    const out = mapCodexEvent(fx.reasoningDelta, freshState())
    expect(out).toEqual([
      {
        type: "reasoning-delta",
        runnerId: root,
        messageId: "msg_1",
        text: "thinking",
      },
    ] satisfies CanonicalEvent[])
  })

  it("maps item/reasoning/summaryTextDelta to a reasoning-delta", () => {
    const out = mapCodexEvent(fx.reasoningSummaryDelta, freshState())
    expect(out).toEqual([
      {
        type: "reasoning-delta",
        runnerId: root,
        messageId: "msg_1",
        text: "summary",
      },
    ] satisfies CanonicalEvent[])
  })
})

describe("mapCodexEvent — command execution lifecycle", () => {
  it("maps command item/started → tool-call-started(shell) with command + cwd input", () => {
    const state = freshState()
    const out = mapCodexEvent(fx.cmdStarted, state)
    expect(out).toEqual([
      {
        type: "tool-call-started",
        runnerId: root,
        callId: "call_1",
        tool: "shell",
        input: { command: "ls -la", cwd: "/repo" },
      },
    ] satisfies CanonicalEvent[])
  })

  it("maps outputDelta → tool-output-delta on the registered callId", () => {
    const state = freshState()
    mapCodexEvent(fx.cmdStarted, state)
    expect(mapCodexEvent(fx.cmdOutput, state)).toEqual([
      {
        type: "tool-output-delta",
        runnerId: root,
        callId: "call_1",
        chunk: "total 8\n",
      },
    ] satisfies CanonicalEvent[])
  })

  it("maps a completed command → tool-call-finished(ok) with exitCode 0 and aggregated output", () => {
    const state = freshState()
    mapCodexEvent(fx.cmdStarted, state)
    expect(mapCodexEvent(fx.cmdCompleted, state)).toEqual([
      {
        type: "tool-call-finished",
        runnerId: root,
        callId: "call_1",
        status: "ok",
        output: "total 8\n",
        exitCode: 0,
      },
    ] satisfies CanonicalEvent[])
  })

  it("maps a failed command → tool-call-finished(error) carrying exitCode 1", () => {
    const out = mapCodexEvent(fx.cmdFailed, freshState())
    expect(out).toEqual([
      {
        type: "tool-call-finished",
        runnerId: root,
        callId: "call_1",
        status: "error",
        output: "",
        exitCode: 1,
      },
    ] satisfies CanonicalEvent[])
  })

  it("maps a fileChange item → one file-change event per change with mapped kind", () => {
    const out = mapCodexEvent(fx.fileChange, freshState())
    expect(out).toEqual([
      {
        type: "file-change",
        runnerId: root,
        path: "src/a.ts",
        kind: "update",
        diff: "@@ -1 +1 @@",
      },
      {
        type: "file-change",
        runnerId: root,
        path: "src/new.ts",
        kind: "add",
        diff: "+new",
      },
    ] satisfies CanonicalEvent[])
  })
})

describe("mapCodexEvent — Collab sub-agents", () => {
  it("maps a spawnAgent collab tool call to a child runner-started under the root", () => {
    const state = freshState() // newRunnerId() -> "rnr_child"
    const out = mapCodexEvent(fx.collabSpawn, state)
    expect(out).toEqual([
      {
        type: "runner-started",
        runnerId: "rnr_child" as RunnerId,
        parentRunnerId: root,
        spawnedByCallId: "it_collab",
        agentType: "codex-subagent",
      },
    ] satisfies CanonicalEvent[])
    expect(state.runnerIds.get("th_child")).toBe("rnr_child" as RunnerId)
  })

  it("ignores non-spawn collab tools (sendInput/wait/closeAgent) — no canonical event", () => {
    const sendInput = {
      ...fx.collabSpawn,
      params: {
        ...fx.collabSpawn.params,
        item: {
          ...(fx.collabSpawn.params as never as { item: object }).item,
          tool: "sendInput",
        },
      },
    } as never
    expect(mapCodexEvent(sendInput, freshState())).toEqual([])
  })

  it("attributes a turn/completed on the child thread to the CHILD runner after the spawn registered it", () => {
    const state = freshState()
    mapCodexEvent(fx.collabSpawn, state) // registers th_child -> rnr_child
    const out = mapCodexEvent(fx.childTurnCompleted, state)
    expect(out).toEqual([
      { type: "turn-finished", runnerId: "rnr_child" as RunnerId },
    ] satisfies CanonicalEvent[])
  })

  it("handles an unknown item type defensively (no throw, no event)", () => {
    expect(mapCodexEvent(fx.unknownItemStarted, freshState())).toEqual([])
  })

  it("handles an unknown notification method defensively (no throw, no event)", () => {
    const unknown = { method: "totally/unknown", params: {} } as never
    expect(mapCodexEvent(unknown, freshState())).toEqual([])
  })
})
