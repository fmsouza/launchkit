import { describe, expect, it } from "bun:test"
import * as config from "./index"

describe("@spectrum/config barrel", () => {
  it("exports every public schema, factory, and constant when imported", () => {
    for (const name of [
      "SettingsSchema",
      "ConfigSchema",
      "CURRENT_CONFIG_VERSION",
      "defaultConfig",
      "migrations",
      "runMigrations",
      "createInMemoryConfigFile",
      "createFsConfigFile",
      "createFileConfigStore",
      "createCachedConfigStore",
    ]) {
      expect(config).toHaveProperty(name)
    }
  })

  it("wires a cached file store save/load round-trip through the in-memory fake from the barrel", async () => {
    const file = config.createInMemoryConfigFile()
    const store = config.createCachedConfigStore(
      config.createFileConfigStore({ file }),
    )

    const next = {
      ...config.defaultConfig(),
      settings: {
        proxyPort: 4100,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        collapsedProjects: [],
        lastByHarness: {},
        updateChannel: "stable" as const,
        dismissedUpdateVersion: null,
        dismissedUpdateHash: null,
        firstTokenTimeoutMs: 120000,
        interTokenTimeoutMs: 60000,
        windowBounds: null,
        sessionNameModelId: null,
      },
    }
    const saved = await store.save(next)
    expect(saved).toEqual({ ok: true, value: undefined })

    // Disk holds the pretty-printed config; the cache serves the load.
    expect(file.writes[0]).toBe(JSON.stringify(next, null, 2))
    expect(await store.load()).toEqual({ ok: true, value: next })
  })
})
