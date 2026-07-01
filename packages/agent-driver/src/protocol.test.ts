import { describe, expect, it } from "bun:test"
import type { StoredEvent } from "@spectrum/agent-events"
import { ModelIdSchema, SessionIdSchema } from "@spectrum/types"
import { decodeRunnerInbound } from "./protocol"
import type { RunnerOutbound } from "./protocol"

const id = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")

describe("RunnerOutbound", () => {
  it("accepts a session-renamed frame shape", () => {
    const frame: RunnerOutbound = {
      type: "session-renamed",
      id,
      name: "New name",
    }
    expect(frame.type).toBe("session-renamed")
    expect(frame).toEqual({ type: "session-renamed", id, name: "New name" })
  })

  it("runner-event remains a valid frame", () => {
    const stored: StoredEvent = {
      seq: 0,
      sessionId: id,
      ts: "2026-06-08T10:00:00.000Z",
      event: { type: "runner-started", runnerId: "r_root" as never },
    }
    const frame: RunnerOutbound = { type: "runner-event", id, event: stored }
    expect(frame.type).toBe("runner-event")
  })

  it("accepts a session-resume-token frame shape", () => {
    const frame: RunnerOutbound = {
      type: "session-resume-token",
      id,
      resumeToken: "claude-sess-1",
    }
    expect(frame.type).toBe("session-resume-token")
    expect(frame).toEqual({
      type: "session-resume-token",
      id,
      resumeToken: "claude-sess-1",
    })
  })
})

describe("decodeRunnerInbound", () => {
  it("rejects an unknown inbound type (session-renamed is outbound-only)", () => {
    const r = decodeRunnerInbound({ type: "session-renamed", id, name: "x" })
    expect(r.ok).toBe(false)
  })

  it("rejects a session-resume-token as inbound (it is outbound-only)", () => {
    const r = decodeRunnerInbound({
      type: "session-resume-token",
      id,
      resumeToken: "x",
    })
    expect(r.ok).toBe(false)
  })

  it("decodes a run-attach message", () => {
    const r = decodeRunnerInbound({ type: "run-attach", id })
    expect(r.ok && r.value).toEqual({ type: "run-attach", id })
  })

  it("decodes a run-send message with text", () => {
    const r = decodeRunnerInbound({ type: "run-send", id, text: "hi" })
    expect(r.ok && r.value).toEqual({ type: "run-send", id, text: "hi" })
  })

  it("decodes a run-approve message with a requestId and decision", () => {
    const r = decodeRunnerInbound({
      type: "run-approve",
      id,
      requestId: "req_1",
      decision: "allow",
    })
    expect(r.ok && r.value).toEqual({
      type: "run-approve",
      id,
      requestId: "req_1",
      decision: "allow",
    })
  })

  it("decodes a run-interrupt message", () => {
    const r = decodeRunnerInbound({ type: "run-interrupt", id })
    expect(r.ok && r.value).toEqual({ type: "run-interrupt", id })
  })

  it("rejects an unknown decision on run-approve as bad-message", () => {
    const r = decodeRunnerInbound({
      type: "run-approve",
      id,
      requestId: "req_1",
      decision: "maybe",
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.kind).toBe("bad-message")
  })

  it("rejects an unknown message type as bad-message", () => {
    const r = decodeRunnerInbound({ type: "pty-input", id, data: "x" })
    expect(!r.ok && r.error.kind).toBe("bad-message")
  })

  it("rejects a non-object payload as bad-message", () => {
    expect(decodeRunnerInbound("nope").ok).toBe(false)
  })

  it("decodes a run-set-mode message", () => {
    const r = decodeRunnerInbound({ type: "run-set-mode", id, mode: "plan" })
    expect(r.ok && r.value).toEqual({ type: "run-set-mode", id, mode: "plan" })
  })

  it("rejects an unknown mode on run-set-mode as bad-message", () => {
    const r = decodeRunnerInbound({ type: "run-set-mode", id, mode: "yolo" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.kind).toBe("bad-message")
  })

  it("decodes a run-set-model message", () => {
    const modelId = ModelIdSchema.parse("mdl_x")
    const r = decodeRunnerInbound({ type: "run-set-model", id, modelId })
    expect(r.ok && r.value).toEqual({
      type: "run-set-model",
      id,
      modelId,
    })
  })

  it("rejects an empty modelId on run-set-model as bad-message", () => {
    const r = decodeRunnerInbound({ type: "run-set-model", id, modelId: "" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.kind).toBe("bad-message")
  })

  it("decodes a run-answer message", () => {
    const r = decodeRunnerInbound({
      type: "run-answer",
      id: "s1",
      requestId: "q1",
      answer: { selections: [{ questionIndex: 0, labels: ["A"] }] },
    })
    expect(r.ok).toBe(true)
  })

  it("decodes run-set-model with a null modelId (switch to default)", () => {
    const result = decodeRunnerInbound({
      type: "run-set-model",
      id: "s_1",
      modelId: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      type: "run-set-model",
      id: "s_1" as never,
      modelId: null,
    })
  })

  it("decodes a run-set-thinking-effort command", () => {
    const r = decodeRunnerInbound({
      type: "run-set-thinking-effort",
      id: "sess-1",
      effort: "high",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        type: "run-set-thinking-effort",
        id: "sess-1" as never,
        effort: "high",
      })
    }
  })

  it("decodeRunnerInbound accepts run-send with attachments", () => {
    const decoded = decodeRunnerInbound({
      type: "run-send",
      id: "s1",
      text: "hi",
      attachments: [
        {
          id: "h1",
          mime: "image/png",
          displayName: "p.png",
          kind: "image",
          bytes: 4,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
      clientSendId: "c1",
    })
    expect(decoded.ok).toBe(true)
  })

  it("decodeRunnerInbound accepts run-send without attachments", () => {
    const decoded = decodeRunnerInbound({
      type: "run-send",
      id: "s1",
      text: "hi",
    })
    expect(decoded.ok).toBe(true)
  })

  it("decodeRunnerInbound rejects run-send with a malformed attachment (missing dataUrl)", () => {
    const decoded = decodeRunnerInbound({
      type: "run-send",
      id: "s1",
      text: "hi",
      attachments: [
        {
          id: "h1",
          mime: "image/png",
          displayName: "p.png",
          kind: "image",
          bytes: 4,
        },
      ],
    })
    expect(decoded.ok).toBe(false)
  })
})
