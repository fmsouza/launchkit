import { describe, expect, it } from "bun:test"
import type { CanonicalEvent } from "@spectrum/agent-events"
import type { RunnerId } from "@spectrum/types"
import {
  agentMessageChunkFixture,
  availableCommandsUpdateFixture,
  configOptionUpdateFixture,
  emptyTextChunkFixture,
  modeChangeFixture,
  noMessageIdChunkFixture,
  planFixture,
  planRemovedFixture,
  planUpdateFixture,
  sessionInfoUpdateFixture,
  thoughtChunkFixture,
  toolCallCompletedFixture,
  toolCallFailedFixture,
  toolCallInProgressFixture,
  toolCallNoStatusFixture,
  toolCallPendingFixture,
  toolCallReEmitFixture,
  unknownUpdateFixture,
  usageUpdateFixture,
  usageUpdateNullFixture,
  userMessageChunkFixture,
} from "./fixtures/acp-updates"
import { type AcpMapState, mapAcpUpdate } from "./map-acp-update"

const rid = (s: string): RunnerId => s as RunnerId

const newState = (): AcpMapState => ({
  rootRunnerId: rid("rnr_root"),
  newRunnerId: () => rid("rnr_child"),
  startedToolCalls: new Set<string>(),
})

const map = (fixture: typeof agentMessageChunkFixture): CanonicalEvent[] =>
  mapAcpUpdate(fixture, newState())

describe("mapAcpUpdate — agent_message_chunk", () => {
  it("maps an agent_message_chunk to a text-delta with role assistant", () => {
    const events = map(agentMessageChunkFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "text-delta",
      runnerId: "rnr_root",
      messageId: "msg_1",
      text: "Hello, I'll help you with that.",
      role: "assistant",
    })
  })

  it("drops an agent_message_chunk with empty text", () => {
    const events = map(emptyTextChunkFixture)
    expect(events).toEqual([])
  })

  it("synthesizes a messageId when the chunk omits one", () => {
    const events = map(noMessageIdChunkFixture)
    expect(events).toHaveLength(1)
    if (events[0]?.type === "text-delta") {
      expect(events[0].messageId.length).toBeGreaterThan(0)
    }
  })
})

describe("mapAcpUpdate — agent_thought_chunk", () => {
  it("maps an agent_thought_chunk to a reasoning-delta", () => {
    const events = map(thoughtChunkFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "reasoning-delta",
      runnerId: "rnr_root",
      messageId: "msg_thought_1",
      text: "Let me think about this...",
    })
  })

  it("drops an agent_thought_chunk with empty content", () => {
    const events = mapAcpUpdate(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "m",
          content: { type: "text", text: "" },
        },
      },
      newState(),
    )
    expect(events).toEqual([])
  })
})

describe("mapAcpUpdate — tool_call", () => {
  it("maps a pending tool_call to a tool-call-started event", () => {
    const events = map(toolCallPendingFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-call-started",
      runnerId: "rnr_root",
      callId: "call_001",
      tool: "Reading config",
    })
  })

  it("defaults status to pending when omitted", () => {
    const events = map(toolCallNoStatusFixture)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("tool-call-started")
  })

  it("does not double-start a tool on re-emit of the same toolCallId", () => {
    const state = newState()
    mapAcpUpdate(toolCallPendingFixture, state)
    const events = mapAcpUpdate(toolCallReEmitFixture, state)
    expect(events).toEqual([])
  })

  it("drops a tool_call with an empty toolCallId", () => {
    const events = mapAcpUpdate(
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "",
          title: "x",
          kind: "other",
        },
      },
      newState(),
    )
    expect(events).toEqual([])
  })
})

describe("mapAcpUpdate — tool_call_update", () => {
  it("maps an in_progress update to a tool-output-delta", () => {
    const events = map(toolCallInProgressFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-output-delta",
      runnerId: "rnr_root",
      callId: "call_001",
    })
  })

  it("maps a completed update to a tool-call-finished with status ok", () => {
    const events = map(toolCallCompletedFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-call-finished",
      runnerId: "rnr_root",
      callId: "call_001",
      status: "ok",
    })
  })

  it("maps a failed update to a tool-call-finished with status error", () => {
    const events = map(toolCallFailedFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-call-finished",
      callId: "call_001",
      status: "error",
    })
  })
})

describe("mapAcpUpdate — plan", () => {
  it("maps a plan to a plan-update event with entries", () => {
    const events = map(planFixture)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("plan-update")
    if (events[0]?.type === "plan-update") {
      expect(events[0].entries.length).toBe(3)
      expect(events[0].planId.length).toBeGreaterThan(0)
    }
  })

  it("reuses the same planId across plan revisions so the reducer replaces the plan", () => {
    // ACP re-sends the WHOLE plan on every revision; Spectrum's plan-update replaces by planId.
    // A fresh id per revision would append a new plan card for every status change.
    const state = newState()
    const first = mapAcpUpdate(planFixture, state)
    const second = mapAcpUpdate(planUpdateFixture, state)
    expect(first[0]?.type).toBe("plan-update")
    expect(second[0]?.type).toBe("plan-update")
    if (first[0]?.type === "plan-update" && second[0]?.type === "plan-update") {
      expect(second[0].planId).toBe(first[0].planId)
      expect(second[0].entries[0]?.status).toBe("completed")
    }
  })

  it("maps a plan_update the same way as a plan", () => {
    const events = map(planUpdateFixture)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("plan-update")
  })
})

describe("mapAcpUpdate — deliberately ignored v1 kinds", () => {
  it("ignores a user_message_chunk (the runtime already echoed the user turn)", () => {
    expect(map(userMessageChunkFixture)).toEqual([])
  })

  it("ignores an available_commands_update", () => {
    expect(map(availableCommandsUpdateFixture)).toEqual([])
  })

  it("ignores a session_info_update", () => {
    expect(map(sessionInfoUpdateFixture)).toEqual([])
  })

  it("ignores a config_option_update", () => {
    expect(map(configOptionUpdateFixture)).toEqual([])
  })

  it("ignores a plan_removed", () => {
    expect(map(planRemovedFixture)).toEqual([])
  })
})

describe("mapAcpUpdate — usage_update", () => {
  it("maps a usage_update to a usage event with contextUsed/contextSize", () => {
    const events = map(usageUpdateFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "usage",
      runnerId: "rnr_root",
    })
    if (events[0]?.type === "usage") {
      expect(events[0].usage.contextUsed).toBe(53000)
      expect(events[0].usage.contextSize).toBe(200000)
    }
  })

  it("drops a usage_update with null used/size (no context reported)", () => {
    const events = map(usageUpdateNullFixture)
    expect(events).toEqual([])
  })
})

describe("mapAcpUpdate — current_mode_update", () => {
  it("maps a current_mode_update to a mode-change annotation carrying the mode id", () => {
    const events = map(modeChangeFixture)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "annotation",
      runnerId: "rnr_root",
      kind: "mode-change",
      data: "plan",
    })
  })
})

describe("mapAcpUpdate — defensive", () => {
  it("returns [] for an unknown sessionUpdate kind", () => {
    const events = map(unknownUpdateFixture)
    expect(events).toEqual([])
  })
})
