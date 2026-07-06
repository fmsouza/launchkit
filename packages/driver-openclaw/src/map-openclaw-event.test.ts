import { describe, expect, it } from "bun:test"
import type { RunnerId } from "@spectrum/agent-events"
import {
  assistantDeltaFixture,
  childRunStartedFixture,
  execApprovalRequestedFixture,
  runCompletedFixture,
  runFailedFixture,
  runStartedFixture,
  toolCallSequenceFixture,
  usageFixture,
} from "./fixtures/openclaw-events"
import {
  type OpenclawMapState,
  mapOpenclawEvent,
  newOpenclawMapState,
} from "./map-openclaw-event"

const ROOT = "rnr_root" as RunnerId

// A deterministic RunnerId minter for sub-agents (the adapter passes ctx.newRunnerId in prod).
const mkState = (): OpenclawMapState => {
  let n = 0
  return newOpenclawMapState({
    rootRunnerId: ROOT,
    newRunnerId: () => `rnr_child_${++n}` as RunnerId,
  })
}

describe("mapOpenclawEvent", () => {
  it("maps run.started for the root session to runner-started (root, model)", () => {
    const state = mkState()
    const out = mapOpenclawEvent(runStartedFixture, state)
    expect(out).toEqual([
      {
        type: "runner-started",
        runnerId: ROOT,
        model: "anthropic/claude-opus-4-6",
      },
    ])
  })

  it("maps assistant.delta to a text-delta keyed by messageId", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    const out = mapOpenclawEvent(assistantDeltaFixture, state)
    expect(out).toEqual([
      { type: "text-delta", runnerId: ROOT, messageId: "m-1", text: "Hello" },
    ])
  })

  it("maps the tool.call.* lifecycle to started -> output-delta -> finished(ok, exitCode)", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    const [startedEvent, deltaEvent, completedEvent] = toolCallSequenceFixture
    if (
      startedEvent === undefined ||
      deltaEvent === undefined ||
      completedEvent === undefined
    )
      throw new Error("fixture sequence incomplete")
    const started = mapOpenclawEvent(startedEvent, state)
    const delta = mapOpenclawEvent(deltaEvent, state)
    const completed = mapOpenclawEvent(completedEvent, state)
    expect(started).toEqual([
      {
        type: "tool-call-started",
        runnerId: ROOT,
        callId: "c-1",
        tool: "shell",
        input: { command: "ls" },
      },
    ])
    expect(delta).toEqual([
      {
        type: "tool-output-delta",
        runnerId: ROOT,
        callId: "c-1",
        chunk: "file-a\n",
      },
    ])
    expect(completed).toEqual([
      {
        type: "tool-call-finished",
        runnerId: ROOT,
        callId: "c-1",
        status: "ok",
        output: "file-a\n",
        exitCode: 0,
      },
    ])
  })

  it("maps exec.approval.requested to approval-requested (requestId = approvalId, kind+detail)", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    const out = mapOpenclawEvent(execApprovalRequestedFixture, state)
    expect(out).toEqual([
      {
        type: "approval-requested",
        runnerId: ROOT,
        requestId: "a-1",
        target: { kind: "command", detail: "rm -rf build" },
      },
    ])
  })

  it("maps a child run.started to runner-started with a fresh child id, parentRunnerId, spawnedByCallId", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    const out = mapOpenclawEvent(childRunStartedFixture, state)
    expect(out).toEqual([
      {
        type: "runner-started",
        runnerId: "rnr_child_1" as RunnerId,
        parentRunnerId: ROOT,
        spawnedByCallId: "c-1",
        agentType: "researcher",
      },
    ])
  })

  it("routes a child session's later events to the child runner id", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    mapOpenclawEvent(childRunStartedFixture, state)
    const childDelta = mapOpenclawEvent(
      {
        type: "event",
        event: "assistant.delta",
        payload: { sessionKey: "s-child", messageId: "cm-1", deltaText: "hi" },
      },
      state,
    )
    expect(childDelta).toEqual([
      {
        type: "text-delta",
        runnerId: "rnr_child_1" as RunnerId,
        messageId: "cm-1",
        text: "hi",
      },
    ])
  })

  it("buffers usage and emits it on run.completed, then turn-finished (the session stays alive)", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    expect(mapOpenclawEvent(usageFixture, state)).toEqual([
      {
        type: "usage",
        runnerId: ROOT,
        usage: { inputTokens: 120, outputTokens: 48, costUsd: 0.0012 },
      },
    ])
    const done = mapOpenclawEvent(runCompletedFixture, state)
    expect(done).toEqual([{ type: "turn-finished", runnerId: ROOT }])
  })

  it("maps run.failed to the error as assistant text + turn-finished (a failed turn does not end the session)", () => {
    const state = mkState()
    mapOpenclawEvent(runStartedFixture, state)
    const out = mapOpenclawEvent(runFailedFixture, state)
    expect(out).toEqual([
      {
        type: "text-delta",
        runnerId: ROOT,
        messageId: "run-error-s-root",
        text: "⚠️ provider timeout",
      },
      { type: "turn-finished", runnerId: ROOT },
    ])
  })

  it("ignores events for an unknown session before its run.started (defensive, returns [])", () => {
    const state = mkState()
    const out = mapOpenclawEvent(
      {
        type: "event",
        event: "assistant.delta",
        payload: { sessionKey: "s-ghost", deltaText: "x" },
      },
      state,
    )
    expect(out).toEqual([])
  })
})
