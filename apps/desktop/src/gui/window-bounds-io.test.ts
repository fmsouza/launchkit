import { describe, expect, it, mock } from "bun:test"
import { type Config, type ConfigStore, defaultConfig } from "@spectrum/config"
import type { ConfigError } from "@spectrum/config"
import { createNoopLogger } from "@spectrum/logger"
import { type Result, err, ok } from "@spectrum/utils"
import { DEFAULT_BOUNDS } from "./window-bounds"
import { createWindowBoundsIO } from "./window-bounds-io"

const validBounds = { width: 1280, height: 800, x: 50, y: 60 }

const makeFakeConfig = (
  initial: Config,
  saveResult: Result<void, ConfigError> = ok(undefined),
): { store: ConfigStore; saved: Config[]; current: () => Config } => {
  let current = initial
  const saved: Config[] = []
  const store: ConfigStore = {
    load: async () => ok(current),
    save: async (c: Config) => {
      if (saveResult.ok) {
        current = c
        saved.push(c)
      }
      return saveResult
    },
  }
  return { store, saved, current: () => current }
}

/** A controllable timer: captures the latest scheduled callback so the test fires it. */
const makeFakeTimer = (): {
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  fire: () => void
  cleared: () => number
} => {
  let pending: (() => void) | null = null
  let clears = 0
  return {
    setTimer: (fn) => {
      pending = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      clears += 1
    },
    fire: () => {
      const fn = pending
      pending = null
      if (fn) fn()
    },
    cleared: () => clears,
  }
}

describe("createWindowBoundsIO.loadInitialFrame", () => {
  it("returns the persisted bounds when they pass the sanity guard", async () => {
    const config = defaultConfig()
    config.settings.windowBounds = validBounds
    const { store } = makeFakeConfig(config)
    const io = createWindowBoundsIO({ config: store, log: createNoopLogger() })
    expect(await io.loadInitialFrame()).toEqual(validBounds)
  })

  it("returns DEFAULT_BOUNDS when no bounds are stored", async () => {
    const { store } = makeFakeConfig(defaultConfig())
    const io = createWindowBoundsIO({ config: store, log: createNoopLogger() })
    expect(await io.loadInitialFrame()).toEqual(DEFAULT_BOUNDS)
  })

  it("returns DEFAULT_BOUNDS when stored bounds fail the guard (off-screen)", async () => {
    const config = defaultConfig()
    config.settings.windowBounds = { ...validBounds, x: 999999 }
    const { store } = makeFakeConfig(config)
    const io = createWindowBoundsIO({ config: store, log: createNoopLogger() })
    expect(await io.loadInitialFrame()).toEqual(DEFAULT_BOUNDS)
  })

  it("returns DEFAULT_BOUNDS and logs when config.load fails", async () => {
    const store: ConfigStore = {
      load: async () => err({ kind: "parse-failed", detail: "bad json" }),
      save: async () => ok(undefined),
    }
    const error = mock(() => {})
    const io = createWindowBoundsIO({
      config: store,
      log: { ...createNoopLogger(), error },
    })
    expect(await io.loadInitialFrame()).toEqual(DEFAULT_BOUNDS)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it("returns DEFAULT_BOUNDS without logging when config.load returns not-found", async () => {
    const store: ConfigStore = {
      load: async () => err({ kind: "not-found" }),
      save: async () => ok(undefined),
    }
    const error = mock(() => {})
    const io = createWindowBoundsIO({
      config: store,
      log: { ...createNoopLogger(), error },
    })
    expect(await io.loadInitialFrame()).toEqual(DEFAULT_BOUNDS)
    expect(error).not.toHaveBeenCalled()
  })
})

describe("createWindowBoundsIO.onBoundsChange", () => {
  it("does not save until the debounce timer fires", async () => {
    const { store, saved } = makeFakeConfig(defaultConfig())
    const timer = makeFakeTimer()
    const io = createWindowBoundsIO({
      config: store,
      log: createNoopLogger(),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    })
    io.onBoundsChange(validBounds)
    expect(saved).toHaveLength(0)
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.settings.windowBounds).toEqual(validBounds)
  })

  it("coalesces rapid changes: clears the prior timer and saves only the last", async () => {
    const { store, saved } = makeFakeConfig(defaultConfig())
    const timer = makeFakeTimer()
    const io = createWindowBoundsIO({
      config: store,
      log: createNoopLogger(),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    })
    io.onBoundsChange({ ...validBounds, width: 1000 })
    io.onBoundsChange(validBounds)
    expect(timer.cleared()).toBe(1)
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.settings.windowBounds).toEqual(validBounds)
  })

  it("logs an error when the save fails and does not throw", async () => {
    const { store } = makeFakeConfig(defaultConfig(), {
      ok: false,
      error: { kind: "write-failed", detail: "disk full" },
    })
    const log = createNoopLogger()
    const error = mock(() => {})
    const io = createWindowBoundsIO({
      config: store,
      log: { ...log, error },
      setTimer: (fn) => {
        fn()
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })
    io.onBoundsChange(validBounds)
    await Promise.resolve()
    await Promise.resolve()
    expect(error).toHaveBeenCalledTimes(1)
  })
})
