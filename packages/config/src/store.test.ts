import { describe, it, expect } from "bun:test"
import { createInMemoryConfigFile } from "./file"
import { createFileConfigStore } from "./store"
import { defaultConfig, CURRENT_CONFIG_VERSION } from "./schema"

describe("createFileConfigStore.load", () => {
  it("returns factory defaults when the file does not exist", async () => {
    const store = createFileConfigStore({ file: createInMemoryConfigFile() })
    const result = await store.load()
    expect(result).toEqual({ ok: true, value: defaultConfig() })
  })

  it("loads, migrates, and validates an existing v1 file into a current Config", async () => {
    const v1OnDisk = JSON.stringify({
      version: 1,
      providers: [
        {
          id: "p_openai",
          name: "OpenAI",
          sdkProvider: "openai",
          apiKey: "sk-legacy",
          config: {},
          models: ["gpt-4o"],
        },
      ],
      aliases: [],
    })
    const store = createFileConfigStore({ file: createInMemoryConfigFile(v1OnDisk) })

    const result = await store.load()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.providers[0]?.secrets).toEqual({})
  })

  it("returns parse-failed when the file contains invalid JSON", async () => {
    const store = createFileConfigStore({ file: createInMemoryConfigFile("{ not json") })
    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("parse-failed")
  })

  it("returns migration-failed when the parsed JSON has a future version", async () => {
    const onDisk = JSON.stringify({ version: 999, providers: [], aliases: [], settings: {} })
    const store = createFileConfigStore({ file: createInMemoryConfigFile(onDisk) })
    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })
})
