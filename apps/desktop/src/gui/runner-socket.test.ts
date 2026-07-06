import { describe, expect, it } from "bun:test"
import type {
  RunManager,
  RunnerInbound,
  RunnerOutbound,
} from "@spectrum/agent-driver"
import { SessionIdSchema } from "@spectrum/types"
import { makeRunnerSocketHandlers } from "./runner-socket"

const id = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")

const makeManager = (): {
  manager: RunManager
  bound: ((m: RunnerOutbound) => void)[]
  inbound: RunnerInbound[]
} => {
  const bound: ((m: RunnerOutbound) => void)[] = []
  const inbound: RunnerInbound[] = []
  const manager: RunManager = {
    launch: () => ({ ok: true, value: { sessionId: id } }),
    handleInbound: (m) => {
      inbound.push(m)
    },
    bindSend: (send) => {
      bound.push(send)
    },
    markUserNamed: () => {},
  }
  return { manager, bound, inbound }
}

describe("makeRunnerSocketHandlers", () => {
  it("binds the manager's send sink to the socket on open", () => {
    const { manager, bound } = makeManager()
    const handlers = makeRunnerSocketHandlers(manager)
    const sentRaw: string[] = []
    handlers.open({ send: (s: string) => sentRaw.push(s) })
    expect(bound).toHaveLength(1)
    const frame: RunnerOutbound = {
      type: "runner-event",
      id,
      event: {
        seq: 0,
        sessionId: id,
        ts: "2026-06-08T12:00:00.000Z",
        event: { type: "runner-started", runnerId: "r" as never },
      },
    }
    bound[0]?.(frame)
    expect(JSON.parse(sentRaw[0] ?? "null")).toEqual(frame)
  })

  it("decodes a valid inbound JSON message and forwards it to handleInbound", () => {
    const { manager, inbound } = makeManager()
    const handlers = makeRunnerSocketHandlers(manager)
    handlers.message(JSON.stringify({ type: "run-send", id, text: "go" }))
    expect(inbound).toEqual([{ type: "run-send", id, text: "go" }])
  })

  it("ignores a non-string message", () => {
    const { manager, inbound } = makeManager()
    const handlers = makeRunnerSocketHandlers(manager)
    handlers.message(new Uint8Array([1, 2, 3]))
    expect(inbound).toEqual([])
  })

  it("ignores invalid JSON", () => {
    const { manager, inbound } = makeManager()
    const handlers = makeRunnerSocketHandlers(manager)
    handlers.message("{not json")
    expect(inbound).toEqual([])
  })

  it("ignores a structurally invalid (bad-message) payload", () => {
    const { manager, inbound } = makeManager()
    const handlers = makeRunnerSocketHandlers(manager)
    handlers.message(
      JSON.stringify({
        type: "run-approve",
        id,
        requestId: "r",
        decision: "maybe",
      }),
    )
    expect(inbound).toEqual([])
  })

  it("calls onConnect when the socket opens", () => {
    const { manager } = makeManager()
    let connected = 0
    const handlers = makeRunnerSocketHandlers(manager, {
      onConnect: () => {
        connected += 1
      },
    })
    handlers.open({ send: () => {} })
    expect(connected).toBe(1)
  })

  it("calls onDisconnect when the socket closes", () => {
    const { manager } = makeManager()
    let disconnected = 0
    const handlers = makeRunnerSocketHandlers(manager, {
      onDisconnect: () => {
        disconnected += 1
      },
    })
    handlers.close()
    expect(disconnected).toBe(1)
  })
})
