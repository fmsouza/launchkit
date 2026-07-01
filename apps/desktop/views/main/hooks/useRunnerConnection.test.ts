import { describe, expect, it } from "bun:test"
import { renderHook, waitFor } from "@testing-library/react"
import { createRunnerClient } from "../runner/runnerClient"
import { useRunnerConnection } from "./useRunnerConnection"

describe("useRunnerConnection", () => {
  it("returns the latest reported connection state", async () => {
    const client = createRunnerClient(() => {})
    const { result } = renderHook(() =>
      useRunnerConnection({ runnerClient: client, now: () => 0, tickMs: 5 }),
    )
    expect(result.current.state).toBe("connecting")
    client.reportConnectionState("connected")
    await waitFor(() => expect(result.current.state).toBe("connected"))
  })

  it("forces a reconnect after a wake-gap when no frames arrived recently", async () => {
    let t = 0
    let reconnects = 0
    const client = createRunnerClient(() => {})
    // Override the two transport-backed methods for the test.
    const testClient = {
      ...client,
      getLastFrameMs: () => -100_000, // very stale
      reconnect: () => {
        reconnects += 1
      },
    }
    renderHook(() =>
      useRunnerConnection({
        runnerClient: testClient,
        now: () => t,
        tickMs: 5,
        gapMs: 100,
        staleMs: 100,
      }),
    )
    t = 10_000 // simulate sleep: next tick sees a wake-gap
    await waitFor(() => expect(reconnects).toBeGreaterThan(0))
  })

  it("does NOT reconnect after a wake-gap while frames are recent (streaming)", async () => {
    let t = 0
    let reconnects = 0
    const client = createRunnerClient(() => {})
    const testClient = {
      ...client,
      getLastFrameMs: () => t, // a frame arrived "now" every tick
      reconnect: () => {
        reconnects += 1
      },
    }
    renderHook(() =>
      useRunnerConnection({
        runnerClient: testClient,
        now: () => t,
        tickMs: 5,
        gapMs: 100,
        staleMs: 100,
      }),
    )
    t = 10_000
    await new Promise((r) => setTimeout(r, 40))
    expect(reconnects).toBe(0)
  })
})
