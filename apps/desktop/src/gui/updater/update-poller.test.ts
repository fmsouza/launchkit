import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { createUpdatePoller } from "./update-poller"

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "applying"
  | "error"

const fakeLogger = (): Logger & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    info: (msg: string) => calls.push(`info:${msg}`),
    warn: (msg: string) => calls.push(`warn:${msg}`),
    error: (msg: string) => calls.push(`error:${msg}`),
    debug: (msg: string) => calls.push(`debug:${msg}`),
    child: () => fakeLogger(),
  } as unknown as Logger & { calls: string[] }
}

/** Fake timer that only fires when we tick it, and tracks the running id. */
const fakeTimers = () => {
  let id = 0
  let fn: (() => void) | null = null
  let running: number | null = null
  return {
    setInterval: (f: () => void, _ms: number) => {
      id += 1
      fn = f
      running = id
      return id
    },
    clearInterval: (cleared: number) => {
      if (cleared === running) {
        running = null
        fn = null
      }
    },
    tick: async () => {
      if (fn === null) return
      await fn()
    },
    isRunning: () => running !== null,
  }
}

describe("createUpdatePoller", () => {
  it("calls check on each interval tick", async () => {
    let checks = 0
    const timers = fakeTimers()
    const poller = createUpdatePoller({
      check: async () => {
        checks += 1
      },
      getPhase: () => "up-to-date",
      intervalMs: 1000,
      timers,
      logger: fakeLogger(),
    })
    poller.start()
    await timers.tick()
    await timers.tick()
    expect(checks).toBe(2)
    poller.stop()
  })

  it("does not check before start", async () => {
    let checks = 0
    const timers = fakeTimers()
    const _poller = createUpdatePoller({
      check: async () => {
        checks += 1
      },
      getPhase: () => "up-to-date",
      intervalMs: 1000,
      timers,
      logger: fakeLogger(),
    })
    // Not started — tick is a no-op (no fn registered).
    await timers.tick()
    expect(checks).toBe(0)
  })

  it("stops checking after stop", async () => {
    let checks = 0
    const timers = fakeTimers()
    const poller = createUpdatePoller({
      check: async () => {
        checks += 1
      },
      getPhase: () => "up-to-date",
      intervalMs: 1000,
      timers,
      logger: fakeLogger(),
    })
    poller.start()
    poller.stop()
    await timers.tick()
    expect(checks).toBe(0)
    expect(timers.isRunning()).toBe(false)
  })

  it("keeps ticking after a check that rejects", async () => {
    let checks = 0
    const timers = fakeTimers()
    const poller = createUpdatePoller({
      check: async () => {
        checks += 1
        if (checks === 1) throw new Error("boom")
      },
      getPhase: () => "up-to-date",
      intervalMs: 1000,
      timers,
      logger: fakeLogger(),
    })
    poller.start()
    await timers.tick() // throws — must not kill the interval
    await timers.tick() // still ticking
    expect(checks).toBe(2)
    poller.stop()
  })

  it("skips the check when phase is downloading or applying", async () => {
    let checks = 0
    let phase: Phase = "downloading"
    const timers = fakeTimers()
    const poller = createUpdatePoller({
      check: async () => {
        checks += 1
      },
      getPhase: () => phase,
      intervalMs: 1000,
      timers,
      logger: fakeLogger(),
    })
    poller.start()
    await timers.tick() // downloading → skip
    phase = "applying"
    await timers.tick() // applying → skip
    phase = "up-to-date"
    await timers.tick() // resumes
    expect(checks).toBe(1)
    poller.stop()
  })

  it("logs a poll error at the boundary when check fails", async () => {
    const log = fakeLogger()
    const timers = fakeTimers()
    const poller = createUpdatePoller({
      check: async () => {
        throw new Error("offline")
      },
      getPhase: () => "up-to-date",
      intervalMs: 1000,
      timers,
      logger: log,
    })
    poller.start()
    await timers.tick()
    expect(log.calls.some((c) => c.startsWith("error:update.poll.error"))).toBe(
      true,
    )
    poller.stop()
  })
})
