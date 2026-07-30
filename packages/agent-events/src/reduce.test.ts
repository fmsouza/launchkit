import { describe, expect, it } from "bun:test"
import type { RunnerId } from "@spectrum/types"
import type { AttachmentCapabilities, AttachmentRef } from "./attachment"
import type { CanonicalEvent } from "./events"
import {
  type QuestionItem,
  type RunState,
  type ToolCallItem,
  initialRunState,
  reduce,
} from "./reduce"

const rid = (s: string): RunnerId => s as RunnerId
const fold = (events: readonly CanonicalEvent[]): RunState =>
  events.reduce(reduce, initialRunState)

const started = (
  runnerId: string,
  extra: Partial<Extract<CanonicalEvent, { type: "runner-started" }>> = {},
): CanonicalEvent => ({
  type: "runner-started",
  runnerId: rid(runnerId),
  ...extra,
})

describe("reduce — runner lifecycle", () => {
  it("creates a running root runner and sets rootRunnerId when the first parentless runner starts", () => {
    const state = fold([started("root")])
    expect(state.rootRunnerId).toBe(rid("root"))
    const runner = state.runners.get(rid("root"))
    expect(runner?.status).toBe("running")
    expect(runner?.items).toEqual([])
  })

  it("updates rootRunnerId to the new runner when a second parentless runner starts (resume continuation)", () => {
    // On session resume the manager folds the prior backlog then a fresh root runner-started
    // arrives with a new id. The new runner becomes the rendered root (it inherits history).
    const state = fold([started("root"), started("other")])
    expect(state.rootRunnerId).toBe(rid("other"))
  })

  it("sets a runner's status when it finishes", () => {
    const state = fold([
      started("root"),
      { type: "runner-finished", runnerId: rid("root"), status: "completed" },
    ])
    expect(state.runners.get(rid("root"))?.status).toBe("completed")
  })

  it("ignores a runner-finished for an unknown runner", () => {
    const state = fold([
      started("root"),
      { type: "runner-finished", runnerId: rid("ghost"), status: "errored" },
    ])
    expect(state.runners.has(rid("ghost"))).toBe(false)
    expect(state.runners.get(rid("root"))?.status).toBe("running")
  })

  it("propagates the error string from a runner-finished:errored event into RunnerState", () => {
    const state = fold([
      started("root"),
      {
        type: "runner-finished",
        runnerId: rid("root"),
        status: "errored",
        error: "Provider returned 429 Too Many Requests",
      },
    ])
    expect(state.runners.get(rid("root"))?.status).toBe("errored")
    expect(state.runners.get(rid("root"))?.error).toBe(
      "Provider returned 429 Too Many Requests",
    )
  })

  it("omits error from RunnerState when runner-finished carries no error field", () => {
    const state = fold([
      started("root"),
      { type: "runner-finished", runnerId: rid("root"), status: "errored" },
    ])
    expect(state.runners.get(rid("root"))?.error).toBeUndefined()
  })

  it("omits error from RunnerState when a runner finishes successfully", () => {
    const state = fold([
      started("root"),
      { type: "runner-finished", runnerId: rid("root"), status: "completed" },
    ])
    expect(state.runners.get(rid("root"))?.error).toBeUndefined()
  })

  it("a re-emitted runner-started preserves the runner's existing items + title (idempotent)", () => {
    // The runtime marks the root started up front; the harness re-emits runner-started later
    // (e.g. claude's system/init). The accumulated conversation must NOT be reset.
    const state = fold([
      started("root", { title: "main" }),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "hello",
      },
      started("root"), // re-emit with no title
    ])
    const runner = state.runners.get(rid("root"))
    expect(runner?.items).toEqual([
      { kind: "message", messageId: "m1", role: "assistant", text: "hello" },
    ])
    expect(runner?.title).toBe("main")
    expect(runner?.status).toBe("running")
  })
})

describe("reduce: root runner-started title re-emit is idempotent", () => {
  it("preserves accumulated items and updates the title when a root runner-started re-emits with a title", () => {
    let state = initialRunState
    const root = "rnr_root" as never
    // Initial root start (no title) + a user text-delta accumulates an item.
    state = reduce(state, { type: "runner-started", runnerId: root })
    state = reduce(state, {
      type: "text-delta",
      runnerId: root,
      messageId: "m1",
      text: "hi",
      role: "user",
    })
    // A later root re-emit WITH a title (e.g. OpenCode info.title) must keep the item.
    state = reduce(state, {
      type: "runner-started",
      runnerId: root,
      title: "Harness title",
    })
    const runner = state.runners.get(root)
    expect(runner?.title).toBe("Harness title")
    expect(runner?.items).toHaveLength(1)
    expect(state.rootRunnerId).toBe(root)
  })
})

describe("reduce — text/reasoning accumulation", () => {
  it("accumulates text-delta chunks into one message item by messageId", () => {
    const state = fold([
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "Hel",
      },
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "lo",
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([
      { kind: "message", messageId: "m1", role: "assistant", text: "Hello" },
    ])
  })

  it("stamps a message with role:user when the text-delta carries role user (the user's own turn)", () => {
    const state = fold([
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "u1",
        text: "do the thing",
        role: "user",
      },
    ])
    expect(state.runners.get(rid("root"))?.items).toEqual([
      { kind: "message", messageId: "u1", role: "user", text: "do the thing" },
    ])
  })

  it("interleaves two concurrent messageIds on the same runner without mixing their text", () => {
    const state = fold([
      started("root"),
      { type: "text-delta", runnerId: rid("root"), messageId: "m1", text: "A" },
      { type: "text-delta", runnerId: rid("root"), messageId: "m2", text: "B" },
      { type: "text-delta", runnerId: rid("root"), messageId: "m1", text: "C" },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([
      { kind: "message", messageId: "m1", role: "assistant", text: "AC" },
      { kind: "message", messageId: "m2", role: "assistant", text: "B" },
    ])
  })

  it("accumulates reasoning-delta chunks into one reasoning item by messageId", () => {
    const state = fold([
      started("root"),
      {
        type: "reasoning-delta",
        runnerId: rid("root"),
        messageId: "r1",
        text: "a",
      },
      {
        type: "reasoning-delta",
        runnerId: rid("root"),
        messageId: "r1",
        text: "b",
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([{ kind: "reasoning", messageId: "r1", text: "ab" }])
  })
})

describe("reduce — tool calls", () => {
  it("pushes a running tool call on tool-call-started", () => {
    const state = fold([
      started("root"),
      {
        type: "tool-call-started",
        runnerId: rid("root"),
        callId: "c1",
        tool: "Bash",
        input: { command: "ls" },
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([
      {
        kind: "tool-call",
        callId: "c1",
        tool: "Bash",
        input: { command: "ls" },
        status: "running",
      },
    ])
  })

  it("appends tool-output-delta chunks to the matching tool call output", () => {
    const state = fold([
      started("root"),
      {
        type: "tool-call-started",
        runnerId: rid("root"),
        callId: "c1",
        tool: "Bash",
      },
      {
        type: "tool-output-delta",
        runnerId: rid("root"),
        callId: "c1",
        chunk: "foo",
      },
      {
        type: "tool-output-delta",
        runnerId: rid("root"),
        callId: "c1",
        chunk: "bar",
      },
    ])
    const item = (state.runners.get(rid("root"))?.items ??
      [])[0] as ToolCallItem
    expect(item.output).toBe("foobar")
    expect(item.status).toBe("running")
  })

  it("sets status/output/exitCode/result on tool-call-finished", () => {
    const state = fold([
      started("root"),
      {
        type: "tool-call-started",
        runnerId: rid("root"),
        callId: "c1",
        tool: "Bash",
      },
      {
        type: "tool-call-finished",
        runnerId: rid("root"),
        callId: "c1",
        status: "ok",
        output: "done",
        exitCode: 0,
        result: { ok: true },
      },
    ])
    const item = (state.runners.get(rid("root"))?.items ??
      [])[0] as ToolCallItem
    expect(item.status).toBe("ok")
    expect(item.output).toBe("done")
    expect(item.exitCode).toBe(0)
    expect(item.result).toEqual({ ok: true })
  })
})

describe("reduce — sub-runner linkage", () => {
  it("links a spawned sub-runner to its parent tool call via spawnedByCallId", () => {
    const state = fold([
      started("root"),
      {
        type: "tool-call-started",
        runnerId: rid("root"),
        callId: "c1",
        tool: "Task",
      },
      started("child", { parentRunnerId: rid("root"), spawnedByCallId: "c1" }),
    ])
    const parentItem = (state.runners.get(rid("root"))?.items ??
      [])[0] as ToolCallItem
    expect(parentItem.spawnedRunnerId).toBe(rid("child"))
    const child = state.runners.get(rid("child"))
    expect(child?.parentRunnerId).toBe(rid("root"))
    expect(child?.status).toBe("running")
  })
})

describe("reduce — file changes", () => {
  it("pushes a file-change item mapping kind to changeKind", () => {
    const state = fold([
      started("root"),
      {
        type: "file-change",
        runnerId: rid("root"),
        callId: "c1",
        path: "/x/y.ts",
        kind: "update",
        diff: "@@",
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([
      {
        kind: "file-change",
        callId: "c1",
        path: "/x/y.ts",
        changeKind: "update",
        diff: "@@",
      },
    ])
  })
})

describe("reduce — approvals", () => {
  it("pushes an approval item on approval-requested and resolves it on approval-resolved", () => {
    const state = fold([
      started("root"),
      {
        type: "approval-requested",
        runnerId: rid("root"),
        requestId: "req1",
        target: { kind: "command", detail: "rm -rf" },
      },
      {
        type: "approval-resolved",
        runnerId: rid("root"),
        requestId: "req1",
        decision: "allow",
        by: "user",
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toEqual([
      {
        kind: "approval",
        requestId: "req1",
        target: { kind: "command", detail: "rm -rf" },
        decision: "allow",
        by: "user",
      },
    ])
  })
})

describe("reduce — usage", () => {
  it("sets runner usage on a usage event", () => {
    const state = fold([
      started("root"),
      {
        type: "usage",
        runnerId: rid("root"),
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ])
    expect(state.runners.get(rid("root"))?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    })
  })

  it("sets runner usage on turn-finished when usage is present", () => {
    const state = fold([
      started("root"),
      {
        type: "turn-finished",
        runnerId: rid("root"),
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ])
    expect(state.runners.get(rid("root"))?.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    })
  })

  it("leaves usage unset on turn-finished without usage", () => {
    const state = fold([
      started("root"),
      { type: "turn-finished", runnerId: rid("root") },
    ])
    expect(state.runners.get(rid("root"))?.usage).toBeUndefined()
  })
})

describe("reduce — turn errors", () => {
  it("marks the referenced message with an error tone when a turn finishes with an error", () => {
    const state = fold([
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "API Error: 429 you have reached your session usage limit",
      },
      {
        type: "turn-finished",
        runnerId: rid("root"),
        error: {
          detail: "API Error: 429 you have reached your session usage limit",
          messageId: "m1",
        },
      },
    ])
    expect(state.runners.get(rid("root"))?.items).toEqual([
      {
        kind: "message",
        messageId: "m1",
        role: "assistant",
        text: "API Error: 429 you have reached your session usage limit",
        tone: "error",
      },
    ])
  })

  it("keeps the runner running after a turn error (the session stays alive for a retry)", () => {
    const state = fold([
      started("root"),
      {
        type: "turn-finished",
        runnerId: rid("root"),
        error: { detail: "rate limited" },
      },
    ])
    expect(state.runners.get(rid("root"))?.status).toBe("running")
    expect(state.runners.get(rid("root"))?.error).toBeUndefined()
  })

  it("appends an error-toned message when the turn error references no existing message", () => {
    const state = fold([
      started("root"),
      {
        type: "turn-finished",
        runnerId: rid("root"),
        error: { detail: "rate limited" },
      },
    ])
    expect(state.runners.get(rid("root"))?.items).toEqual([
      {
        kind: "message",
        messageId: "turn-error-0",
        role: "assistant",
        text: "rate limited",
        tone: "error",
      },
    ])
  })

  it("still records usage when a turn finishes with both usage and an error", () => {
    const state = fold([
      started("root"),
      {
        type: "turn-finished",
        runnerId: rid("root"),
        usage: { inputTokens: 1, outputTokens: 2 },
        error: { detail: "rate limited" },
      },
    ])
    expect(state.runners.get(rid("root"))?.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    })
  })

  it("leaves messages untoned on a turn-finished without error", () => {
    const state = fold([
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "hello",
      },
      { type: "turn-finished", runnerId: rid("root") },
    ])
    expect(state.runners.get(rid("root"))?.items).toEqual([
      { kind: "message", messageId: "m1", role: "assistant", text: "hello" },
    ])
  })
})

describe("reduce — annotation & defensiveness", () => {
  it("keeps state unchanged on an annotation event", () => {
    const before = fold([started("root")])
    const after = reduce(before, {
      type: "annotation",
      runnerId: rid("root"),
      kind: "todo",
      data: { items: [] },
    })
    expect(after.runners.get(rid("root"))?.items).toEqual([])
  })

  it("does not mutate the input state (purity)", () => {
    const before = fold([started("root")])
    const snapshot = before.runners.get(rid("root"))?.items
    const after = reduce(before, {
      type: "text-delta",
      runnerId: rid("root"),
      messageId: "m1",
      text: "hi",
    })
    expect(snapshot).toEqual([])
    expect(before.runners.get(rid("root"))?.items).toEqual([])
    // The original items array must be the exact same object reference — reduce
    // must not have replaced or mutated it in place.
    expect(after.runners.get(rid("root"))?.items).not.toBe(snapshot)
    expect(before.runners.get(rid("root"))?.items).toBe(snapshot)
  })

  it("is a no-op for a text-delta event whose runnerId was never started", () => {
    const state = fold([
      {
        type: "text-delta",
        runnerId: rid("ghost"),
        messageId: "m1",
        text: "hi",
      },
    ])
    expect(state.runners.size).toBe(0)
    expect(state.runners.has(rid("ghost"))).toBe(false)
  })
})

describe("reduce — supportedModes", () => {
  it("projects supportedModes onto the runner and preserves them across idempotent re-emits", () => {
    const startedWithModes = reduce(initialRunState, {
      type: "runner-started",
      runnerId: rid("rnr_1"),
      supportedModes: ["manual", "bypass"],
    })
    expect(startedWithModes.runners.get(rid("rnr_1"))?.supportedModes).toEqual([
      "manual",
      "bypass",
    ])
    const reEmit = reduce(startedWithModes, {
      type: "runner-started",
      runnerId: rid("rnr_1"),
    })
    expect(reEmit.runners.get(rid("rnr_1"))?.supportedModes).toEqual([
      "manual",
      "bypass",
    ])
  })
})

describe("reduce — session resume continuation", () => {
  it("preserves prior history when a resumed run emits a new root runner", () => {
    const r1 = "rnr-1" as RunnerId
    const r2 = "rnr-2" as RunnerId
    let s = initialRunState
    // Original run: root R1 with one user + one assistant message.
    s = reduce(s, { type: "runner-started", runnerId: r1 })
    s = reduce(s, {
      type: "text-delta",
      runnerId: r1,
      messageId: "m1",
      text: "hello",
      role: "user",
    })
    s = reduce(s, {
      type: "text-delta",
      runnerId: r1,
      messageId: "m2",
      text: "hi there",
      role: "assistant",
    })
    s = reduce(s, {
      type: "runner-finished",
      runnerId: r1,
      status: "completed",
    })
    // Resume: a new root R2 starts (backlog already folded above).
    s = reduce(s, { type: "runner-started", runnerId: r2 })
    s = reduce(s, {
      type: "text-delta",
      runnerId: r2,
      messageId: "m3",
      text: "follow up",
      role: "user",
    })

    const root = s.runners.get(s.rootRunnerId as RunnerId)
    expect(s.rootRunnerId).toBe(r2)
    expect(
      root?.items.map((i) => (i.kind === "message" ? i.messageId : i.kind)),
    ).toEqual(["m1", "m2", "m3"])
  })

  it("keeps items on an idempotent same-id runner-started re-emit", () => {
    const r1 = "rnr-1" as RunnerId
    let s = initialRunState
    s = reduce(s, { type: "runner-started", runnerId: r1 })
    s = reduce(s, {
      type: "text-delta",
      runnerId: r1,
      messageId: "m1",
      text: "hi",
      role: "assistant",
    })
    s = reduce(s, { type: "runner-started", runnerId: r1, title: "My Title" })
    const root = s.runners.get(r1)
    expect(s.rootRunnerId).toBe(r1)
    expect(root?.items).toHaveLength(1)
    expect(root?.title).toBe("My Title")
  })
})

describe("reduce — event-sourcing invariant", () => {
  it("yields identical state whether folded all-at-once or one-by-one", () => {
    const log: readonly CanonicalEvent[] = [
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "He",
      },
      {
        type: "tool-call-started",
        runnerId: rid("root"),
        callId: "c1",
        tool: "Task",
      },
      {
        type: "tool-output-delta",
        runnerId: rid("root"),
        callId: "c1",
        chunk: "out",
      },
      started("child", { parentRunnerId: rid("root"), spawnedByCallId: "c1" }),
      {
        type: "text-delta",
        runnerId: rid("child"),
        messageId: "m2",
        text: "sub",
      },
      {
        type: "tool-call-finished",
        runnerId: rid("root"),
        callId: "c1",
        status: "ok",
        output: "out",
      },
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "llo",
      },
      {
        type: "usage",
        runnerId: rid("root"),
        usage: { inputTokens: 5, outputTokens: 6 },
      },
      { type: "runner-finished", runnerId: rid("child"), status: "completed" },
      { type: "runner-finished", runnerId: rid("root"), status: "completed" },
    ]

    const allAtOnce = log.reduce(reduce, initialRunState)
    let oneByOne: RunState = initialRunState
    for (const event of log) oneByOne = reduce(oneByOne, event)

    const normalize = (s: RunState) => ({
      rootRunnerId: s.rootRunnerId,
      runners: [...s.runners.entries()],
    })
    expect(normalize(allAtOnce)).toEqual(normalize(oneByOne))
  })
})

describe("reduce — questions", () => {
  const prompt = {
    questions: [
      {
        question: "Q?",
        header: "H",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  }
  it("appends a question item on question-requested", () => {
    let s = reduce(initialRunState, {
      type: "runner-started",
      runnerId: rid("r1"),
    })
    s = reduce(s, {
      type: "question-requested",
      runnerId: rid("r1"),
      requestId: "q1",
      prompt,
    })
    const item = s.runners.get(rid("r1"))?.items.at(-1) as QuestionItem
    expect(item.kind).toBe("question")
    expect(item.requestId).toBe("q1")
    expect(item.answer).toBeUndefined()
  })
  it("sets the answer on question-resolved", () => {
    let s = reduce(initialRunState, {
      type: "runner-started",
      runnerId: rid("r1"),
    })
    s = reduce(s, {
      type: "question-requested",
      runnerId: rid("r1"),
      requestId: "q1",
      prompt,
    })
    s = reduce(s, {
      type: "question-resolved",
      runnerId: rid("r1"),
      requestId: "q1",
      answer: { selections: [{ questionIndex: 0, labels: ["A"] }] },
      by: "user",
    })
    const item = s.runners.get(rid("r1"))?.items.at(-1) as QuestionItem
    expect(item.answer?.selections[0]?.labels).toEqual(["A"])
  })
})

describe("reduce — idempotent re-emit (double-replay safety)", () => {
  // The session-resume flow can deliver the same stored event twice (once from
  // the manager's `events.read` replay, once from a redundant `run-attach`).
  // The reducer must NOT re-apply the events below — re-appending would produce
  // duplicate tool calls, duplicate approvals, and concatenated text.

  it("does not duplicate a tool-call-started when re-emitted with the same callId", () => {
    const start: CanonicalEvent = {
      type: "tool-call-started",
      runnerId: rid("root"),
      callId: "c1",
      tool: "Bash",
    }
    const state = fold([started("root"), start, start])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "tool-call", callId: "c1" })
  })

  it("does not duplicate an approval-requested when re-emitted with the same requestId", () => {
    const req: CanonicalEvent = {
      type: "approval-requested",
      runnerId: rid("root"),
      requestId: "req1",
      target: { kind: "command", detail: "rm -rf" },
    }
    const state = fold([started("root"), req, req])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "approval", requestId: "req1" })
  })

  it("does not duplicate a file-change when re-emitted with the same callId", () => {
    const change: CanonicalEvent = {
      type: "file-change",
      runnerId: rid("root"),
      callId: "c1",
      path: "/x/y.ts",
      kind: "update",
    }
    const state = fold([started("root"), change, change])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "file-change", callId: "c1" })
  })

  it("does not concatenate a text-delta when re-emitted with the same messageId", () => {
    const delta: CanonicalEvent = {
      type: "text-delta",
      runnerId: rid("root"),
      messageId: "m1",
      text: "hello",
    }
    const state = fold([started("root"), delta, delta])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "message",
      messageId: "m1",
      text: "hello",
    })
  })

  it("does not duplicate a question-requested when re-emitted with the same requestId", () => {
    // The webview's runnerClient fans out each inbound `runner-event` frame to BOTH the
    // per-session listener (registered by `LiveRunDetail`) AND the firehose `onAny` listener
    // (registered by `AppInner`), so `applyEvent` runs twice for the same stored event.
    // Without reducer-side idempotency the timeline would stack a duplicate QuestionItem and
    // the user would see the same question twice.
    const req: CanonicalEvent = {
      type: "question-requested",
      runnerId: rid("root"),
      requestId: "q1",
      prompt: {
        questions: [
          {
            question: "Proceed?",
            header: "Proceed",
            options: [{ label: "Yes" }, { label: "No" }],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    }
    const state = fold([started("root"), req, req])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "question", requestId: "q1" })
  })
})

describe("reduce — attachments", () => {
  it("folds a user text-delta with attachments into a MessageItem carrying attachments", () => {
    const ref: AttachmentRef = {
      id: "h1",
      mime: "image/png",
      displayName: "p.png",
      kind: "image",
      bytes: 10,
    }
    const state = fold([
      started("root"),
      {
        type: "text-delta",
        runnerId: rid("root"),
        messageId: "m1",
        text: "look",
        role: "user",
        attachments: [ref],
      },
    ])
    const runner = state.runners.get(rid("root"))
    expect(runner).toBeDefined()
    const msg = runner?.items.find((i) => i.kind === "message") as
      | { attachments?: readonly AttachmentRef[] }
      | undefined
    expect(msg?.attachments).toEqual([ref])
  })

  it("runner-started supportedAttachments is folded onto RunnerState", () => {
    const caps: AttachmentCapabilities = {
      image: true,
      pdf: true,
      binary: false,
    }
    const state = fold([started("root", { supportedAttachments: caps })])
    const runner = state.runners.get(rid("root"))
    expect(runner?.supportedAttachments).toEqual(caps)
  })
})

describe("reduce — plan-update", () => {
  it("appends a PlanItem when a plan-update arrives", () => {
    const state = fold([
      started("root"),
      {
        type: "plan-update",
        runnerId: rid("root"),
        planId: "plan-1",
        entries: [
          { content: "Step A", status: "pending" },
          { content: "Step B", status: "in_progress" },
        ],
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "plan",
      planId: "plan-1",
      entries: [
        { content: "Step A", status: "pending" },
        { content: "Step B", status: "in_progress" },
      ],
    })
  })

  it("replaces the PlanItem with the same planId on re-emit (idempotent on planId)", () => {
    const first = fold([
      started("root"),
      {
        type: "plan-update",
        runnerId: rid("root"),
        planId: "plan-1",
        entries: [{ content: "Old", status: "pending" }],
      },
    ])
    const updated = reduce(first, {
      type: "plan-update",
      runnerId: rid("root"),
      planId: "plan-1",
      entries: [{ content: "New", status: "completed" }],
    })
    const items = updated.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "plan",
      planId: "plan-1",
      entries: [{ content: "New", status: "completed" }],
    })
  })

  it("is idempotent: folding the same plan-update twice yields the same RunState", () => {
    const ev: CanonicalEvent = {
      type: "plan-update",
      runnerId: rid("root"),
      planId: "plan-1",
      entries: [{ content: "Step", status: "pending" }],
    }
    const once = fold([started("root"), ev])
    const twice = reduce(once, ev)
    expect(twice).toEqual(once)
  })

  it("keeps multiple distinct plans as separate PlanItems", () => {
    const state = fold([
      started("root"),
      {
        type: "plan-update",
        runnerId: rid("root"),
        planId: "plan-1",
        entries: [{ content: "A", status: "pending" }],
      },
      {
        type: "plan-update",
        runnerId: rid("root"),
        planId: "plan-2",
        entries: [{ content: "B", status: "pending" }],
      },
    ])
    const items = state.runners.get(rid("root"))?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: "plan", planId: "plan-1" })
    expect(items[1]).toMatchObject({ kind: "plan", planId: "plan-2" })
  })

  it("ignores a plan-update for an unknown runner", () => {
    const state = fold([
      started("root"),
      {
        type: "plan-update",
        runnerId: rid("ghost"),
        planId: "plan-1",
        entries: [{ content: "x", status: "pending" }],
      },
    ])
    expect(state.runners.has(rid("ghost"))).toBe(false)
    expect(state.runners.get(rid("root"))?.items).toEqual([])
  })
})

describe("reduce — usage with context size", () => {
  it("folds contextUsed and contextSize into RunnerState.usage", () => {
    const state = fold([
      started("root"),
      {
        type: "usage",
        runnerId: rid("root"),
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          contextUsed: 53000,
          contextSize: 200000,
        },
      },
    ])
    const runner = state.runners.get(rid("root"))
    expect(runner?.usage?.contextUsed).toBe(53000)
    expect(runner?.usage?.contextSize).toBe(200000)
  })
})
