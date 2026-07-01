import { describe, expect, it } from "bun:test"
import { createWsRunnerClient } from "./clients"

// Minimal fake matching the WebSocketLike subset the transport uses.
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  sent: string[] = []
  private cbs: { [k: string]: Array<(e: { data?: unknown }) => void> } = {}
  addEventListener(type: string, cb: (e: { data?: unknown }) => void): void {
    const list = this.cbs[type] ?? []
    this.cbs[type] = list
    list.push(cb)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.fire("close")
  }
  fire(type: string, e: { data?: unknown } = {}): void {
    for (const cb of this.cbs[type] ?? []) cb(e)
  }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.fire("open")
  }
}

const harness = () => {
  const sockets: FakeSocket[] = []
  const timers: Array<() => void> = []
  let clock = 1_000
  const client = createWsRunnerClient("ws://x", {
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    setTimer: (fn) => {
      timers.push(fn)
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
    now: () => clock,
  })
  return {
    client,
    sockets,
    fireTimers: () => {
      const pending = timers.splice(0)
      for (const fn of pending) fn()
    },
    setClock: (t: number) => {
      clock = t
    },
  }
}

describe("createWsRunnerClient", () => {
  it("reports connecting then connected on first open", () => {
    const h = harness()
    const seen: string[] = []
    h.client.onConnectionState((s) => seen.push(s))
    expect(h.client.connectionState()).toBe("connecting")
    h.sockets[0].open()
    expect(h.client.connectionState()).toBe("connected")
    expect(seen).toEqual(["connected"])
  })

  it("buffers sends until open then flushes them", () => {
    const h = harness()
    h.client.attach("s_1" as never)
    expect(h.sockets[0].sent).toEqual([]) // not open yet
    h.sockets[0].open()
    expect(h.sockets[0].sent).toEqual([
      JSON.stringify({ type: "run-attach", id: "s_1" }),
    ])
  })

  it("reconnects with a new socket after a close", () => {
    const h = harness()
    h.sockets[0].open()
    h.sockets[0].close()
    expect(h.client.connectionState()).toBe("reconnecting")
    h.fireTimers() // fire the scheduled backoff reconnect
    expect(h.sockets.length).toBe(2)
    h.sockets[1].open()
    expect(h.client.connectionState()).toBe("connected")
  })

  it("updates getLastFrameMs when a frame arrives", () => {
    const h = harness()
    h.sockets[0].open()
    h.setClock(5_000)
    h.sockets[0].fire("message", {
      data: JSON.stringify({
        type: "runner-event",
        id: "s_1",
        event: {
          seq: 0,
          sessionId: "s_1",
          ts: "t",
          event: { type: "annotation", runnerId: "r" },
        },
      }),
    })
    expect(h.client.getLastFrameMs()).toBe(5_000)
  })

  it("flushes the outbox on a reconnect open, not just the first open", () => {
    const h = harness()
    h.sockets[0].open() // first connect
    h.sockets[0].close() // drop → schedules a reconnect
    h.fireTimers() // reconnect creates socket 2 (still connecting)
    h.client.attach("s_2" as never) // queued: socket 2 is not open yet
    expect(h.sockets[1].sent).toEqual([])
    h.sockets[1].open() // reconnect open must flush the outbox
    expect(h.sockets[1].sent).toEqual([
      JSON.stringify({ type: "run-attach", id: "s_2" }),
    ])
  })

  it("reconnect() drops the current socket and opens a fresh one", () => {
    const h = harness()
    h.sockets[0].open()
    h.client.reconnect()
    expect(h.sockets.length).toBe(2)
    // The stale socket's late close must NOT schedule another reconnect.
    h.sockets[0].fire("close")
    h.fireTimers()
    expect(h.sockets.length).toBe(2)
  })
})
