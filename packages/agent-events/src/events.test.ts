import { describe, expect, it } from "bun:test"
import type { RunnerId } from "@spectrum/types"
import {
  type CanonicalEvent,
  CanonicalEventSchema,
  QuestionAnswerSchema,
  QuestionPromptSchema,
  StoredEventSchema,
  UsageSchema,
} from "./events"

describe("UsageSchema", () => {
  it("parses usage with required and optional fields", () => {
    const parsed = UsageSchema.parse({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      costUsd: 0.01,
    })
    expect(parsed.inputTokens).toBe(10)
    expect(parsed.cachedInputTokens).toBe(2)
  })

  it("parses usage with context-used and context-size", () => {
    const parsed = UsageSchema.parse({
      inputTokens: 10,
      outputTokens: 5,
      contextUsed: 53000,
      contextSize: 200000,
    })
    expect(parsed.contextUsed).toBe(53000)
    expect(parsed.contextSize).toBe(200000)
  })

  it("rejects negative context-used", () => {
    expect(
      UsageSchema.safeParse({
        inputTokens: 1,
        outputTokens: 1,
        contextUsed: -1,
      }).success,
    ).toBe(false)
  })

  it("rejects negative token counts", () => {
    expect(
      UsageSchema.safeParse({ inputTokens: -1, outputTokens: 0 }).success,
    ).toBe(false)
  })

  it("rejects unknown keys (strict)", () => {
    expect(
      UsageSchema.safeParse({ inputTokens: 1, outputTokens: 1, extra: 1 })
        .success,
    ).toBe(false)
  })
})

describe("CanonicalEventSchema", () => {
  it("parses a runner-started event with parent + spawn linkage", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "runner-started",
      runnerId: "rnr_child",
      parentRunnerId: "rnr_root",
      spawnedByCallId: "call_1",
      agentType: "Task",
      title: "sub agent",
      model: "claude",
    })
    expect(parsed.type).toBe("runner-started")
  })

  it("parses a minimal runner-started event (root)", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "runner-started",
      runnerId: "rnr_root",
    })
    expect(parsed.type).toBe("runner-started")
  })

  it("parses a tool-call-started event with opaque input", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "tool-call-started",
      runnerId: "rnr_root",
      callId: "call_1",
      tool: "Bash",
      input: { command: "ls" },
    })
    expect(parsed.type).toBe("tool-call-started")
  })

  it("parses a file-change event mapping kind", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "file-change",
      runnerId: "rnr_root",
      path: "/x/y.ts",
      kind: "update",
      diff: "@@",
    })
    expect(parsed.type).toBe("file-change")
  })

  it("parses an approval-requested event with a target", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "approval-requested",
      runnerId: "rnr_root",
      requestId: "req_1",
      target: { kind: "command", detail: "rm -rf" },
    })
    expect(parsed.type).toBe("approval-requested")
  })

  it("parses a usage event", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "usage",
      runnerId: "rnr_root",
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(parsed.type).toBe("usage")
  })

  it("parses a turn-finished event carrying a turn error with a message reference", () => {
    const parsed = CanonicalEventSchema.parse({
      type: "turn-finished",
      runnerId: "rnr_root",
      error: { detail: "rate limited", messageId: "m1" },
    })
    expect(parsed.type).toBe("turn-finished")
  })

  it("parses a turn-finished error without a messageId", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "turn-finished",
        runnerId: "rnr_root",
        error: { detail: "rate limited" },
      }).success,
    ).toBe(true)
  })

  it("rejects a turn-finished error missing its detail (strict shape)", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "turn-finished",
        runnerId: "rnr_root",
        error: { messageId: "m1" },
      }).success,
    ).toBe(false)
  })

  it("rejects an event with an unknown type", () => {
    expect(
      CanonicalEventSchema.safeParse({ type: "nope", runnerId: "rnr_root" })
        .success,
    ).toBe(false)
  })

  it("rejects a text-delta event missing text (strict shape)", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "text-delta",
        runnerId: "rnr_root",
        messageId: "m1",
      }).success,
    ).toBe(false)
  })

  it("accepts runner-started with a permissionMode and rejects an unknown one", () => {
    const good = CanonicalEventSchema.safeParse({
      type: "runner-started",
      runnerId: "rnr_root",
      permissionMode: "plan",
    })
    expect(good.success).toBe(true)
    const bad = CanonicalEventSchema.safeParse({
      type: "runner-started",
      runnerId: "rnr_root",
      permissionMode: "yolo",
    })
    expect(bad.success).toBe(false)
  })

  it("accepts runner-started with supportedModes and rejects unknown modes", () => {
    const ok = CanonicalEventSchema.safeParse({
      type: "runner-started",
      runnerId: "rnr_1",
      supportedModes: ["manual", "plan"],
    })
    expect(ok.success).toBe(true)
    const bad = CanonicalEventSchema.safeParse({
      type: "runner-started",
      runnerId: "rnr_1",
      supportedModes: ["yolo"],
    })
    expect(bad.success).toBe(false)
  })
})

describe("QuestionPromptSchema", () => {
  it("accepts a multi-question prompt with options and free text", () => {
    const prompt = {
      questions: [
        {
          question: "Which library?",
          header: "Library",
          options: [
            { label: "date-fns", description: "lightweight" },
            { label: "day.js", description: "tiny" },
          ],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    }
    expect(QuestionPromptSchema.parse(prompt)).toEqual(prompt)
  })
  it("requires at least one question", () => {
    expect(QuestionPromptSchema.safeParse({ questions: [] }).success).toBe(
      false,
    )
  })
  it("rejects unknown keys (strict)", () => {
    expect(
      QuestionPromptSchema.safeParse({
        questions: [
          {
            question: "Which library?",
            header: "Library",
            options: [{ label: "date-fns", description: "lightweight" }],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

describe("QuestionAnswerSchema", () => {
  it("accepts index-keyed selections with labels and optional free text", () => {
    const answer = { selections: [{ questionIndex: 0, labels: ["date-fns"] }] }
    expect(QuestionAnswerSchema.parse(answer)).toEqual(answer)
  })

  it("rejects unknown keys (strict)", () => {
    expect(
      QuestionAnswerSchema.safeParse({
        selections: [{ questionIndex: 0, labels: ["date-fns"] }],
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

describe("CanonicalEventSchema question events", () => {
  it("accepts question-requested", () => {
    const ev: CanonicalEvent = {
      type: "question-requested",
      runnerId: "r1" as RunnerId,
      requestId: "q1",
      prompt: {
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    }
    expect(CanonicalEventSchema.parse(ev)).toEqual(ev)
  })
  it("accepts question-resolved", () => {
    const ev: CanonicalEvent = {
      type: "question-resolved",
      runnerId: "r1" as RunnerId,
      requestId: "q1",
      answer: { selections: [{ questionIndex: 0, labels: ["A"] }] },
      by: "user",
    }
    expect(CanonicalEventSchema.parse(ev)).toEqual(ev)
  })

  it("parses a plan-update event with entries", () => {
    const ev: CanonicalEvent = {
      type: "plan-update",
      runnerId: "r1" as RunnerId,
      planId: "plan-1",
      entries: [
        { content: "Check syntax", priority: "high", status: "pending" },
        { content: "Fix types", priority: "medium", status: "in_progress" },
        { content: "Done step", priority: "low", status: "completed" },
      ],
    }
    const parsed = CanonicalEventSchema.parse(ev)
    expect(parsed.type).toBe("plan-update")
    if (parsed.type === "plan-update") {
      expect(parsed.planId).toBe("plan-1")
      expect(parsed.entries.length).toBe(3)
    }
  })

  it("parses a plan-update entry without optional priority", () => {
    const parsed = CanonicalEventSchema.safeParse({
      type: "plan-update",
      runnerId: "r1",
      planId: "plan-1",
      entries: [{ content: "Step", status: "pending" }],
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a plan-update with an empty entries array", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "plan-update",
        runnerId: "r1",
        planId: "plan-1",
        entries: [],
      }).success,
    ).toBe(false)
  })

  it("rejects a plan-update missing planId", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "plan-update",
        runnerId: "r1",
        entries: [{ content: "x", status: "pending" }],
      }).success,
    ).toBe(false)
  })

  it("rejects a plan-update with a bad status", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "plan-update",
        runnerId: "r1",
        planId: "plan-1",
        entries: [{ content: "x", status: "done" }],
      }).success,
    ).toBe(false)
  })

  it("rejects a plan-update with a bad priority", () => {
    expect(
      CanonicalEventSchema.safeParse({
        type: "plan-update",
        runnerId: "r1",
        planId: "plan-1",
        entries: [{ content: "x", priority: "urgent", status: "pending" }],
      }).success,
    ).toBe(false)
  })
})

describe("StoredEventSchema", () => {
  it("parses a stored envelope wrapping a canonical event", () => {
    const parsed = StoredEventSchema.parse({
      seq: 0,
      sessionId: "s_1",
      ts: "2026-06-08T10:00:00.000Z",
      event: {
        type: "text-delta",
        runnerId: "rnr_root",
        messageId: "m1",
        text: "hi",
      },
    })
    expect(parsed.seq).toBe(0)
    expect(parsed.event.type).toBe("text-delta")
  })

  it("rejects a stored envelope with a non-datetime ts", () => {
    expect(
      StoredEventSchema.safeParse({
        seq: 0,
        sessionId: "s_1",
        ts: "yesterday",
        event: {
          type: "text-delta",
          runnerId: "rnr_root",
          messageId: "m1",
          text: "hi",
        },
      }).success,
    ).toBe(false)
  })
})
