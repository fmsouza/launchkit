import { describe, expect, it } from "bun:test"
import {
  type CanonicalEvent,
  type RunState,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import { RunnerIdSchema } from "@spectrum/types"
import { subRunnerDetail } from "./subRunnerDetail"

const root = RunnerIdSchema.parse("run_root")
const child = RunnerIdSchema.parse("run_child")

const fold = (events: readonly CanonicalEvent[]): RunState =>
  events.reduce(reduce, initialRunState)

describe("subRunnerDetail", () => {
  it("returns the child runner's title when present", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "tool-call-started",
        runnerId: root,
        callId: "c1",
        tool: "Task",
        input: { description: "should be ignored" },
      },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "c1",
        title: "search docs",
      },
    ])
    expect(subRunnerDetail(child, state.runners)).toBe("search docs")
  })

  it("falls back to the parent tool-call description when the child has no title", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "tool-call-started",
        runnerId: root,
        callId: "c1",
        tool: "Task",
        input: { description: "Investigate tool rendering", prompt: "long…" },
      },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "c1",
      },
    ])
    expect(subRunnerDetail(child, state.runners)).toBe(
      "Investigate tool rendering",
    )
  })

  it("falls back to the first line of the parent tool-call prompt", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "tool-call-started",
        runnerId: root,
        callId: "c1",
        tool: "Task",
        input: { prompt: "Fix the side panel\nmore detail" },
      },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "c1",
      },
    ])
    expect(subRunnerDetail(child, state.runners)).toBe("Fix the side panel")
  })

  it("returns undefined when the child runner is not in the map", () => {
    const state = fold([{ type: "runner-started", runnerId: root }])
    const unknown = RunnerIdSchema.parse("run_missing")
    expect(subRunnerDetail(unknown, state.runners)).toBeUndefined()
  })

  it("returns undefined when the child has no title and no parent (the root)", () => {
    const state = fold([{ type: "runner-started", runnerId: root }])
    expect(subRunnerDetail(root, state.runners)).toBeUndefined()
  })

  it("returns undefined when the child has no title and the parent has no matching tool-call", () => {
    // Child claims a parent, but the parent's tool-call list has no call with
    // spawnedRunnerId === child (orphaned child).
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "no-such-call",
      },
    ])
    expect(subRunnerDetail(child, state.runners)).toBeUndefined()
  })

  it("returns undefined when the matching parent tool-call has no input", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "tool-call-started",
        runnerId: root,
        callId: "c1",
        tool: "Task",
        // no input
      },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "c1",
      },
    ])
    expect(subRunnerDetail(child, state.runners)).toBeUndefined()
  })
})
