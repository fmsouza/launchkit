import { describe, expect, it } from "bun:test"
import { TabIdSchema, type TerminalOutbound } from "@spectrum/pty"
import { SessionIdSchema } from "@spectrum/types"
import { createTerminalClient } from "./terminalClient"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)
const tabId = TabIdSchema.parse("11111111-1111-4111-8111-111111111111")

describe("createTerminalClient", () => {
  it("sends a term-open message with cwd, cols, rows", () => {
    const sent: unknown[] = []
    const c = createTerminalClient((m) => sent.push(m))
    c.open({ sessionId, tabId, cwd: "/tmp", cols: 80, rows: 24 })
    expect(sent).toEqual([
      { type: "term-open", sessionId, tabId, cwd: "/tmp", cols: 80, rows: 24 },
    ])
  })

  it("sends a term-input message with base64 data", () => {
    const sent: unknown[] = []
    const c = createTerminalClient((m) => sent.push(m))
    c.input({ sessionId, tabId, data: "aGk=" })
    expect(sent).toEqual([
      { type: "term-input", sessionId, tabId, data: "aGk=" },
    ])
  })

  it("sends a term-resize message", () => {
    const sent: unknown[] = []
    const c = createTerminalClient((m) => sent.push(m))
    c.resize({ sessionId, tabId, cols: 120, rows: 40 })
    expect(sent).toEqual([
      { type: "term-resize", sessionId, tabId, cols: 120, rows: 40 },
    ])
  })

  it("sends a term-close message", () => {
    const sent: unknown[] = []
    const c = createTerminalClient((m) => sent.push(m))
    c.close({ sessionId, tabId })
    expect(sent).toEqual([{ type: "term-close", sessionId, tabId }])
  })

  it("dispatches term-output to the registered per-tab listener", () => {
    const c = createTerminalClient(() => {})
    const received: string[] = []
    c.onOutput(sessionId, tabId, (data) => received.push(data))
    const frame: TerminalOutbound = {
      type: "term-output",
      sessionId,
      tabId,
      data: "aGk=",
    }
    c.dispatch(frame)
    expect(received).toEqual(["aGk="])
  })

  it("dispatches term-exited to the per-tab listener with exitCode", () => {
    const c = createTerminalClient(() => {})
    let exitCode: number | undefined
    c.onExited(sessionId, tabId, (code) => {
      exitCode = code
    })
    c.dispatch({ type: "term-exited", sessionId, tabId, exitCode: 0 })
    expect(exitCode).toBe(0)
  })

  it("dispatches term-error to the per-tab listener", () => {
    const c = createTerminalClient(() => {})
    let msg = ""
    c.onError(sessionId, tabId, (message) => {
      msg = message
    })
    c.dispatch({ type: "term-error", sessionId, tabId, message: "boom" })
    expect(msg).toBe("boom")
  })
})
