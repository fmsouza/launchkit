import { describe, it, expect } from "bun:test"
import { type Result, ok } from "@launchkit/utils"
import type { Config } from "./schema"
import { defaultConfig } from "./schema"
import type { ConfigError } from "./errors"
import type { ConfigStore } from "./store"
import { createCachedConfigStore } from "./cached-store"

/** An inner store that counts loads/saves and lets a test mutate the value it would load. */
const countingStore = (
  initial: Config,
): { store: ConfigStore; loads: () => number; saves: () => number; setBacking: (c: Config) => void } => {
  let loadCount = 0
  let saveCount = 0
  let backing = initial
  return {
    loads: () => loadCount,
    saves: () => saveCount,
    setBacking: (c) => {
      backing = c
    },
    store: {
      load: async (): Promise<Result<Config, ConfigError>> => {
        loadCount += 1
        return ok(backing)
      },
      save: async (config: Config): Promise<Result<void, ConfigError>> => {
        saveCount += 1
        backing = config
        return ok(undefined)
      },
    },
  }
}

describe("createCachedConfigStore", () => {
  it("loads from disk once then serves the cached config on later loads", async () => {
    const inner = countingStore(defaultConfig())
    const cached = createCachedConfigStore(inner.store)

    const first = await cached.load()
    const second = await cached.load()

    expect(first).toEqual({ ok: true, value: defaultConfig() })
    expect(second).toEqual(first)
    expect(inner.loads()).toBe(1) // second load was served from cache, not the inner store
  })

  it("does not cache a failed load so a later load retries the inner store", async () => {
    let attempt = 0
    const flaky: ConfigStore = {
      load: async () => {
        attempt += 1
        return attempt === 1
          ? { ok: false, error: { kind: "not-found" } }
          : { ok: true, value: defaultConfig() }
      },
      save: async () => ({ ok: true, value: undefined }),
    }
    const cached = createCachedConfigStore(flaky)

    expect((await cached.load()).ok).toBe(false)
    expect((await cached.load()).ok).toBe(true) // retried because the failure was not cached
    expect(attempt).toBe(2)
  })

  it("write-through: save updates the cache so the next load returns the saved config without hitting disk", async () => {
    const inner = countingStore(defaultConfig())
    const cached = createCachedConfigStore(inner.store)
    await cached.load() // prime the cache (inner load #1)

    const updated: Config = {
      ...defaultConfig(),
      settings: { proxyPort: 5123, proxyHost: "127.0.0.1" },
    }
    const saved = await cached.save(updated)
    expect(saved).toEqual({ ok: true, value: undefined })

    const afterSave = await cached.load()
    expect(afterSave).toEqual({ ok: true, value: updated })
    expect(inner.saves()).toBe(1)
    expect(inner.loads()).toBe(1) // the post-save load was served from the updated cache
  })

  it("does not update the cache when the inner save fails", async () => {
    const inner = countingStore(defaultConfig())
    const failingSave: ConfigStore = {
      load: inner.store.load,
      save: async () => ({ ok: false, error: { kind: "write-failed", detail: "disk full" } }),
    }
    const cached = createCachedConfigStore(failingSave)
    await cached.load() // cache holds defaultConfig()

    const updated: Config = { ...defaultConfig(), settings: { proxyPort: 9999, proxyHost: "127.0.0.1" } }
    const result = await cached.save(updated)

    expect(result.ok).toBe(false)
    // Cache untouched: a later load still returns the original, served from cache.
    expect(await cached.load()).toEqual({ ok: true, value: defaultConfig() })
  })
})
