import { describe, expect, it } from "bun:test"
import {
  FLOW_LIMITS,
  FLOW_TEXT_LIMITS,
  FlowResponseSchema,
  FlowResultSchema,
  FlowStepSchema,
  clampPollMs,
  isSafeExternalUrl,
} from "./flow"

describe("FlowStepSchema", () => {
  it("rejects a title longer than the title bound", () => {
    // Extension-controlled and rendered verbatim. React escapes it, so the risk is layout,
    // not injection: unbounded, a "title" is capped only by the 256 KB body limit and buries
    // the modal's own cancel button under a wall of text.
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "t".repeat(FLOW_TEXT_LIMITS.maxTitleChars + 1),
        fields: [],
      }).success,
    ).toBe(false)
  })

  it("accepts a title exactly at the title bound", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "t".repeat(FLOW_TEXT_LIMITS.maxTitleChars),
        fields: [],
      }).success,
    ).toBe(true)
  })

  it("rejects an error message longer than the body bound", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "error",
        message: "m".repeat(FLOW_TEXT_LIMITS.maxBodyChars + 1),
      }).success,
    ).toBe(false)
  })

  it("rejects a message step body longer than the body bound", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "message",
        title: "Hi",
        body: "b".repeat(FLOW_TEXT_LIMITS.maxBodyChars + 1),
        tone: "info",
      }).success,
    ).toBe(false)
  })

  it("rejects a form field label longer than the title bound", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "Sign in",
        fields: [
          {
            name: "token",
            label: "l".repeat(FLOW_TEXT_LIMITS.maxTitleChars + 1),
            kind: "text",
            required: true,
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("accepts a form step with fields", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "Sign in",
        fields: [
          { name: "token", label: "Token", kind: "password", required: true },
        ],
      }).success,
    ).toBe(true)
  })

  it("accepts an open-external step with an https url", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "open-external",
        title: "Authorize",
        url: "https://example.com/auth",
      }).success,
    ).toBe(true)
  })

  it("rejects an open-external step whose url is not http or https", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "open-external",
        title: "x",
        url: "file:///etc/passwd",
      }).success,
    ).toBe(false)
  })

  it("accepts a done step carrying config and secrets", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "done",
        config: { serverUrl: "http://127.0.0.1:9000" },
        secrets: { apiKey: "sk" },
      }).success,
    ).toBe(true)
  })

  it("accepts a done step carrying only a message", () => {
    expect(
      FlowStepSchema.safeParse({ kind: "done", message: "Signed in" }).success,
    ).toBe(true)
  })

  it("accepts an await step and keeps its pollMs", () => {
    const parsed = FlowStepSchema.safeParse({
      kind: "await",
      title: "Waiting",
      pollMs: 2500,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.kind === "await")
      expect(parsed.data.pollMs).toBe(2500)
  })

  it("defaults an await step's pollMs when the plugin omits it", () => {
    const parsed = FlowStepSchema.safeParse({ kind: "await", title: "Waiting" })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.kind === "await")
      expect(parsed.data.pollMs).toBe(1000)
  })

  it("rejects a step whose kind is unknown", () => {
    expect(FlowStepSchema.safeParse({ kind: "teleport" }).success).toBe(false)
  })

  it("rejects a select field declaring no options", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "Pick",
        fields: [
          { name: "region", label: "Region", kind: "select", required: true },
        ],
      }).success,
    ).toBe(false)
  })

  it("accepts a select field declaring options", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "form",
        title: "Pick",
        fields: [
          {
            name: "region",
            label: "Region",
            kind: "select",
            required: true,
            options: [{ value: "eu", label: "Europe" }],
          },
        ],
      }).success,
    ).toBe(true)
  })

  it("rejects an unknown property on a step so a typo is loud", () => {
    expect(
      FlowStepSchema.safeParse({
        kind: "error",
        message: "nope",
        retryable: true,
      }).success,
    ).toBe(false)
  })
})

describe("FlowResultSchema", () => {
  it("accepts a form result carrying values", () => {
    expect(
      FlowResultSchema.safeParse({ kind: "form", values: { token: "t" } })
        .success,
    ).toBe(true)
  })

  it("accepts an ack, a poll, and a cancel", () => {
    for (const kind of ["ack", "poll", "cancel"])
      expect(FlowResultSchema.safeParse({ kind }).success).toBe(true)
  })

  it("rejects a result whose kind is unknown", () => {
    expect(FlowResultSchema.safeParse({ kind: "retry" }).success).toBe(false)
  })
})

describe("clampPollMs", () => {
  it("raises a too-small interval to the floor", () => {
    expect(clampPollMs(10)).toBe(FLOW_LIMITS.minPollMs)
  })

  it("lowers a too-large interval to the ceiling", () => {
    expect(clampPollMs(999_999)).toBe(FLOW_LIMITS.maxPollMs)
  })

  it("keeps an in-range interval unchanged", () => {
    expect(clampPollMs(2000)).toBe(2000)
  })
})

describe("isSafeExternalUrl", () => {
  it("accepts an https url", () => {
    expect(isSafeExternalUrl("https://a.b/c")).toBe(true)
  })
  it("accepts an http url", () => {
    expect(isSafeExternalUrl("http://a.b/c")).toBe(true)
  })
  it("rejects a file url", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false)
  })
  it("rejects a custom scheme", () => {
    expect(isSafeExternalUrl("zoommtg://start")).toBe(false)
  })
  it("rejects a javascript url", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false)
  })
  it("rejects a malformed url", () => {
    expect(isSafeExternalUrl("not a url")).toBe(false)
  })
})

describe("FlowResponseSchema", () => {
  it("accepts a response with an optional toast", () => {
    expect(
      FlowResponseSchema.safeParse({
        sessionId: "s1",
        step: { kind: "done", message: "ok" },
        toast: { tone: "success", message: "Signed in" },
      }).success,
    ).toBe(true)
  })

  it("accepts a response with no toast", () => {
    expect(
      FlowResponseSchema.safeParse({
        sessionId: "s1",
        step: { kind: "done" },
      }).success,
    ).toBe(true)
  })

  it("rejects a response missing a session id", () => {
    expect(
      FlowResponseSchema.safeParse({ step: { kind: "done" } }).success,
    ).toBe(false)
  })

  it("rejects a toast whose tone is unknown", () => {
    expect(
      FlowResponseSchema.safeParse({
        sessionId: "s1",
        step: { kind: "done" },
        toast: { tone: "chartreuse", message: "x" },
      }).success,
    ).toBe(false)
  })

  it("rejects a response whose session id is empty", () => {
    const parsed = FlowResponseSchema.safeParse({
      sessionId: "",
      step: { kind: "done" },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success)
      expect(parsed.error.issues.some((i) => i.path[0] === "sessionId")).toBe(
        true,
      )
  })
})
