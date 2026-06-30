import { describe, expect, it } from "bun:test"
import { CURRENT_CONFIG_VERSION, type Config, defaultConfig } from "./schema"
import { exportConfig, importConfig } from "./transfer"

const configWithProvider = (): Config => ({
  version: CURRENT_CONFIG_VERSION,
  providers: [
    {
      id: "p_openai",
      name: "OpenAI",
      sdkProvider: "openai",
      config: { baseUrl: "https://api.openai.com/v1" },
      secrets: { apiKey: { ref: "kc_openai" } },
      models: ["gpt-4o"],
    },
  ],
  models: [
    {
      id: "fast",
      providerId: "p_openai",
      providerModel: "gpt-4o-mini",
      aliases: [],
    },
  ],
  settings: {
    proxyPort: 4000,
    proxyHost: "127.0.0.1",
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
})

describe("exportConfig", () => {
  it("produces 2-space pretty JSON that parses back to the same config", () => {
    const config = configWithProvider()
    const text = exportConfig(config)
    expect(text).toBe(JSON.stringify(config, null, 2))
    expect(JSON.parse(text)).toEqual(config)
  })

  it("includes secret references but never a secret value when exporting", () => {
    const text = exportConfig(configWithProvider())
    // The keychain REF is present (it is not a secret) ...
    expect(text).toContain("kc_openai")
    // ... but no raw secret value or value-shaped field is ever emitted (security.md).
    expect(text).not.toContain("sk-")
    expect(text).not.toContain('"value"')
  })
})

describe("importConfig", () => {
  it("accepts a valid current-version config object and returns it", () => {
    const config = configWithProvider()
    expect(importConfig(config)).toEqual({ ok: true, value: config })
  })

  it("accepts a valid config supplied as a JSON string", () => {
    const config = defaultConfig()
    expect(importConfig(JSON.stringify(config))).toEqual({
      ok: true,
      value: config,
    })
  })

  it("round-trips an exported config back through import to the original", () => {
    const config = configWithProvider()
    const reimported = importConfig(exportConfig(config))
    expect(reimported).toEqual({ ok: true, value: config })
  })

  it("migrates an older config on import by moving inline keys to empty secret refs", () => {
    const v1 = {
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
    }
    const result = importConfig(v1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.providers[0]?.secrets).toEqual({})
  })

  it("returns a parse-failed error when given an invalid JSON string", () => {
    const result = importConfig("{ not json")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("parse-failed")
  })

  it("rejects a foreign object that is not a Spectrum config", () => {
    const result = importConfig({ hello: "world", nested: { a: 1 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })

  it("rejects a config whose provider carries a raw inline secret value", () => {
    const bad = {
      ...configWithProvider(),
      providers: [
        {
          ...configWithProvider().providers[0],
          secrets: { apiKey: "sk-raw-inline" },
        },
      ],
    }
    const result = importConfig(bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })

  it("rejects a non-loopback proxyHost so an imported config can never bind a public interface", () => {
    const bad = {
      ...configWithProvider(),
      settings: { proxyPort: 4000, proxyHost: "0.0.0.0" },
    }
    const result = importConfig(bad)
    expect(result.ok).toBe(false)
  })
})
