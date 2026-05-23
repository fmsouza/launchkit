import { describe, it, expect } from "bun:test"
import { createInMemoryConfigFile } from "./file"
import { createFileConfigStore } from "./store"
import { defaultConfig } from "./schema"

describe("createFileConfigStore.save", () => {
  it("writes the config as 2-space pretty JSON exactly once when given a valid config", async () => {
    const file = createInMemoryConfigFile()
    const store = createFileConfigStore({ file })
    const config = defaultConfig()

    const result = await store.save(config)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(file.writes).toHaveLength(1)
    expect(file.writes[0]).toBe(JSON.stringify(config, null, 2))
  })

  it("round-trips through save then load to the same config", async () => {
    const file = createInMemoryConfigFile()
    const store = createFileConfigStore({ file })
    const config = defaultConfig()

    await store.save(config)
    const loaded = await store.load()

    expect(loaded).toEqual({ ok: true, value: config })
  })

  it("returns write-failed and does not write when the config fails validation", async () => {
    const file = createInMemoryConfigFile()
    const store = createFileConfigStore({ file })
    // A non-loopback host is invalid (security.md) — save must reject before touching the file.
    const invalid = { ...defaultConfig(), settings: { proxyPort: 4000, proxyHost: "0.0.0.0" } }

    const result = await store.save(invalid as ReturnType<typeof defaultConfig>)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("write-failed")
    expect(file.writes).toEqual([])
  })

  it("propagates a write-failed error from the file effect when writeAtomic fails", async () => {
    const failing = {
      writes: [] as readonly string[],
      read: async () => ({ ok: false, error: { kind: "not-found" } }) as const,
      writeAtomic: async () =>
        ({ ok: false, error: { kind: "write-failed", detail: "disk full" } }) as const,
      exists: async () => false,
    }
    const store = createFileConfigStore({ file: failing })

    const result = await store.save(defaultConfig())
    expect(result).toEqual({ ok: false, error: { kind: "write-failed", detail: "disk full" } })
  })
})
