import { describe, expect, it } from "bun:test"
import type { RunnerOutbound } from "@spectrum/agent-driver"
import type {
  AttachmentRefWithBytes,
  QuestionAnswer,
  StoredEvent,
} from "@spectrum/agent-events"
import { SessionIdSchema } from "@spectrum/types"
import { createRunnerClient } from "./runnerClient"

const id = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")

const storedEvent: StoredEvent = {
  seq: 0,
  sessionId: id,
  ts: "2026-06-08T10:00:00.000Z",
  event: {
    type: "text-delta",
    runnerId: "run_root" as never,
    messageId: "m1",
    text: "hi",
  },
}

describe("createRunnerClient", () => {
  it("sends a run-attach message", () => {
    const sent: unknown[] = []
    const c = createRunnerClient((m) => sent.push(m))
    c.attach(id)
    expect(sent).toEqual([{ type: "run-attach", id }])
  })

  it("sends a run-send message with the turn text", () => {
    const sent: unknown[] = []
    const c = createRunnerClient((m) => sent.push(m))
    c.send(id, { text: "do it" })
    expect(sent).toEqual([{ type: "run-send", id, text: "do it" }])
  })

  it("sends a run-approve message with the decision", () => {
    const sent: unknown[] = []
    const c = createRunnerClient((m) => sent.push(m))
    c.approve(id, "rq1", "allow")
    expect(sent).toEqual([
      { type: "run-approve", id, requestId: "rq1", decision: "allow" },
    ])
  })

  it("encodes answer as a run-answer message", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    const answer: QuestionAnswer = {
      selections: [{ questionIndex: 0, labels: ["A"] }],
    }
    client.answer(id, "q1", answer)
    expect(sent).toEqual([{ type: "run-answer", id, requestId: "q1", answer }])
  })

  it("sends a run-interrupt message", () => {
    const sent: unknown[] = []
    const c = createRunnerClient((m) => sent.push(m))
    c.interrupt(id)
    expect(sent).toEqual([{ type: "run-interrupt", id }])
  })

  it("dispatches a runner-event frame to the registered per-session listener", () => {
    const c = createRunnerClient(() => {})
    const got: StoredEvent[] = []
    c.onEvent(id, (e) => got.push(e))
    const frame: RunnerOutbound = {
      type: "runner-event",
      id,
      event: storedEvent,
    }
    c.dispatch(frame)
    expect(got).toEqual([storedEvent])
  })

  it("ignores a frame for a session with no listener", () => {
    const c = createRunnerClient(() => {})
    const frame: RunnerOutbound = {
      type: "runner-event",
      id,
      event: storedEvent,
    }
    expect(() => c.dispatch(frame)).not.toThrow()
  })

  it("encodes run-set-mode", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.setMode(id, "plan")
    expect(sent).toEqual([{ type: "run-set-mode", id, mode: "plan" }])
  })

  it("setModel sends a run-set-model message", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.setModel(id, "mdl_x" as never)
    expect(sent).toEqual([{ type: "run-set-model", id, modelId: "mdl_x" }])
  })

  it("sends run-set-model with a null modelId when default is selected", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.setModel(id, null)
    expect(sent).toEqual([{ type: "run-set-model", id, modelId: null }])
  })

  it("onAny receives every dispatched frame regardless of attach", () => {
    const c = createRunnerClient(() => {})
    const seen: string[] = []
    c.onAny((sid, e) => seen.push(`${sid}:${e.event.type}`))
    const finished: StoredEvent = {
      seq: 1,
      sessionId: id,
      ts: "2026-06-08T10:00:00.000Z",
      event: {
        type: "runner-finished",
        runnerId: "run_root" as never,
        status: "completed",
      },
    }
    const frame: RunnerOutbound = { type: "runner-event", id, event: finished }
    c.dispatch(frame)
    expect(seen).toEqual([`${id}:runner-finished`])
  })

  it("onAny returns an unsubscribe fn that stops further delivery", () => {
    const c = createRunnerClient(() => {})
    const seen: string[] = []
    const off = c.onAny((sid) => seen.push(sid))
    const frame: RunnerOutbound = {
      type: "runner-event",
      id,
      event: storedEvent,
    }
    c.dispatch(frame)
    off()
    c.dispatch(frame)
    expect(seen).toEqual([id])
  })

  it("dispatches a session-renamed frame to onSessionRenamed listeners", () => {
    const c = createRunnerClient(() => {})
    const got: { id: SessionId; name: string }[] = []
    const off = c.onSessionRenamed((id, name) => got.push({ id, name }))
    const frame: RunnerOutbound = {
      type: "session-renamed",
      id,
      name: "New name",
    }
    c.dispatch(frame)
    expect(got).toEqual([{ id, name: "New name" }])
    off()
    c.dispatch(frame)
    expect(got).toHaveLength(1)
  })

  it("dispatches a session-resume-token frame to onResumeToken listeners", () => {
    const c = createRunnerClient(() => {})
    const got: { id: SessionId; resumeToken: string }[] = []
    const off = c.onResumeToken((id, resumeToken) =>
      got.push({ id, resumeToken }),
    )
    const frame: RunnerOutbound = {
      type: "session-resume-token",
      id,
      resumeToken: "tok_abc",
    }
    c.dispatch(frame)
    expect(got).toEqual([{ id, resumeToken: "tok_abc" }])
    off()
    c.dispatch(frame)
    expect(got).toHaveLength(1)
  })

  it("onResumeToken fires for the fresh-restart signal (empty token)", () => {
    const c = createRunnerClient(() => {})
    const got: string[] = []
    c.onResumeToken((_id, resumeToken) => got.push(resumeToken))
    c.dispatch({ type: "session-resume-token", id, resumeToken: "" })
    expect(got).toEqual([""])
  })

  it("includes clientSendId in the run-send message", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.send(id, { text: "hi" }, "c1")
    expect(sent).toEqual([
      { type: "run-send", id, text: "hi", clientSendId: "c1" },
    ])
  })

  it("send encodes run-send with attachments when present", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    const atts: readonly AttachmentRefWithBytes[] = [
      {
        id: "sha_abc",
        mime: "image/png",
        displayName: "shot.png",
        kind: "image",
        bytes: 12,
        dataUrl: "data:image/png;base64,AAAA",
      },
    ]
    client.send(id, { text: "see", attachments: atts }, "c1")
    expect(sent).toEqual([
      {
        type: "run-send",
        id,
        text: "see",
        attachments: [...atts],
        clientSendId: "c1",
      },
    ])
  })

  it("send omits attachments when absent", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.send(id, { text: "hi" }, "c1")
    const frame = sent[0] as Record<string, unknown>
    expect(frame.type).toBe("run-send")
    expect(frame.id).toBe(id)
    expect(frame.text).toBe("hi")
    expect(frame.clientSendId).toBe("c1")
    expect("attachments" in frame).toBe(false)
  })

  it("notifies onConnectionLost subscribers when the transport drops", () => {
    const client = createRunnerClient(() => {})
    let lost = 0
    const off = client.onConnectionLost(() => {
      lost += 1
    })
    client.connectionLost()
    off()
    client.connectionLost()
    expect(lost).toBe(1)
  })

  it("encodes setThinkingEffort to a run-set-thinking-effort message", () => {
    const sent: unknown[] = []
    const client = createRunnerClient((m) => sent.push(m))
    client.setThinkingEffort("sess-1" as SessionId, "high")
    expect(sent).toEqual([
      { type: "run-set-thinking-effort", id: "sess-1", effort: "high" },
    ])
  })
})
