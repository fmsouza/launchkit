import { describe, expect, it } from "bun:test"
import type { UpdateState } from "@spectrum/ipc"
import { makeUpdateSocketHandlers } from "./update-socket"

const state: UpdateState = {
  phase: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: "hashA",
  available: true,
  progress: 0,
  error: null,
  channel: "stable",
  showBanner: true,
}

describe("makeUpdateSocketHandlers", () => {
  it("push sends the JSON-encoded UpdateState to the connected socket", () => {
    const sent: string[] = []
    const handlers = makeUpdateSocketHandlers()
    handlers.open({ send: (d: string) => sent.push(d) })
    handlers.push(state)
    expect(sent).toEqual([JSON.stringify(state)])
  })

  it("push drops silently when no webview is connected", () => {
    const sent: string[] = []
    const handlers = makeUpdateSocketHandlers()
    // No open() call — no socket connected.
    handlers.push(state)
    expect(sent).toEqual([])
  })

  it("push drops silently when send throws", () => {
    const handlers = makeUpdateSocketHandlers()
    handlers.open({
      send: () => {
        throw new Error("closing")
      },
    })
    expect(() => handlers.push(state)).not.toThrow()
  })

  it("open/close track connection liveness — push after close is a no-op", () => {
    const sent: string[] = []
    const handlers = makeUpdateSocketHandlers()
    handlers.open({ send: (d: string) => sent.push(d) })
    handlers.close()
    handlers.push(state)
    expect(sent).toEqual([])
  })
})
