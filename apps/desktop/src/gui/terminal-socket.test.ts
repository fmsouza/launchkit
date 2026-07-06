import { describe, expect, it } from "bun:test"
import {
  TabIdSchema,
  type TerminalInbound,
  type TerminalManager,
  type TerminalOutbound,
  createFakePtySpawner,
  createTerminalManager,
} from "@spectrum/pty"
import { SessionIdSchema } from "@spectrum/types"
import { makeTerminalSocketHandlers } from "./terminal-socket"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)
const tabId = TabIdSchema.parse("11111111-1111-4111-8111-111111111111")

const fakeManager = (log: {
  inbound: TerminalInbound[]
  sends: TerminalOutbound[]
}): TerminalManager => ({
  bindSend: (sink) => {
    ;(fakeManager as unknown as { sink: typeof sink }).sink = sink
  },
  handleInbound: (frame) => {
    log.inbound.push(frame)
  },
  launch: () => ({
    ok: true,
    value: { tabId, write: () => {}, resize: () => {}, kill: () => {} },
  }),
  dispose: () => {},
})

describe("makeTerminalSocketHandlers", () => {
  it("binds the manager sink to ws.send on open", () => {
    const sent: string[] = []
    const ws = { send: (d: string) => sent.push(d) }
    const log = {
      inbound: [] as TerminalInbound[],
      sends: [] as TerminalOutbound[],
    }
    const mgr = fakeManager(log)
    const handlers = makeTerminalSocketHandlers(mgr)
    handlers.open(ws)
    // After open, manager.bindSend's sink should be ws.send. We can't reach it directly,
    // but we can verify open didn't throw and that a subsequent message routes.
    handlers.message(JSON.stringify({ type: "term-attach", sessionId, tabId }))
    expect(log.inbound).toHaveLength(1)
  })

  it("decodes a valid term-input frame and forwards to manager.handleInbound", () => {
    const log = {
      inbound: [] as TerminalInbound[],
      sends: [] as TerminalOutbound[],
    }
    const mgr = fakeManager(log)
    const handlers = makeTerminalSocketHandlers(mgr)
    handlers.open({ send: () => {} })
    handlers.message(
      JSON.stringify({ type: "term-input", sessionId, tabId, data: "aGk=" }),
    )
    expect(log.inbound[0]?.type).toBe("term-input")
  })

  it("drops malformed JSON without throwing", () => {
    const log = {
      inbound: [] as TerminalInbound[],
      sends: [] as TerminalOutbound[],
    }
    const mgr = fakeManager(log)
    const handlers = makeTerminalSocketHandlers(mgr)
    handlers.open({ send: () => {} })
    expect(() => handlers.message("{not json")).not.toThrow()
    expect(log.inbound).toHaveLength(0)
  })

  it("drops a non-string message without throwing", () => {
    const log = {
      inbound: [] as TerminalInbound[],
      sends: [] as TerminalOutbound[],
    }
    const mgr = fakeManager(log)
    const handlers = makeTerminalSocketHandlers(mgr)
    handlers.open({ send: () => {} })
    expect(() => handlers.message(new ArrayBuffer(8))).not.toThrow()
    expect(log.inbound).toHaveLength(0)
  })

  it("spawns a PTY and emits term-opened over the wire when a term-open frame arrives", () => {
    // End-to-end guard: a real TerminalManager wired through the socket must
    // turn an inbound `term-open` frame into a spawned PTY + `term-opened`
    // outbound. Regression guard for the missing term-open→launch wiring.
    const sent: TerminalOutbound[] = []
    const mgr = createTerminalManager({ spawner: createFakePtySpawner() })
    const handlers = makeTerminalSocketHandlers(mgr)
    handlers.open({ send: (d: string) => sent.push(JSON.parse(d)) })
    handlers.message(
      JSON.stringify({
        type: "term-open",
        sessionId,
        tabId,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      }),
    )
    expect(sent.some((m) => m.type === "term-opened")).toBe(true)
    expect(sent.some((m) => m.type === "term-error")).toBe(false)
  })

  it("fires onDisconnect on close", () => {
    const log = {
      inbound: [] as TerminalInbound[],
      sends: [] as TerminalOutbound[],
    }
    const mgr = fakeManager(log)
    let disconnected = false
    const handlers = makeTerminalSocketHandlers(mgr, {
      onDisconnect: () => {
        disconnected = true
      },
    })
    handlers.close()
    expect(disconnected).toBe(true)
  })
})
