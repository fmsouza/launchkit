import { describe, expect, it } from "bun:test"
import {
  CURRENT_CONFIG_VERSION,
  ConfigSchema,
  SettingsSchema,
  defaultConfig,
} from "./schema"

const validProvider = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secrets: { apiKey: { ref: "kc_openai" } },
  models: ["gpt-4o", "gpt-4o-mini"],
}

describe("SettingsSchema", () => {
  it("defaults proxyPort to 4000 and proxyHost to loopback when given an empty object", () => {
    expect(SettingsSchema.parse({})).toEqual({
      proxyPort: 4000,
      proxyHost: "127.0.0.1",
      lastSelectedFolder: "",
      lastSelectedHarnessId: "",
      collapsedProjects: [],
      lastByHarness: {},
      updateChannel: "stable",
      dismissedUpdateVersion: null,
      dismissedUpdateHash: null,
      firstTokenTimeoutMs: 120000,
      interTokenTimeoutMs: 60000,
      windowBounds: null,
      sessionNameModelId: null,
    })
  })

  it("accepts a complete windowBounds object", () => {
    const parsed = SettingsSchema.parse({
      windowBounds: { width: 1280, height: 800, x: 50, y: 60 },
    })
    expect(parsed.windowBounds).toEqual({
      width: 1280,
      height: 800,
      x: 50,
      y: 60,
    })
  })

  it("rejects a partial windowBounds object (missing fields)", () => {
    expect(
      SettingsSchema.safeParse({ windowBounds: { width: 1280 } }).success,
    ).toBe(false)
  })
  it("rejects a non-loopback proxyHost so the proxy can never bind a public interface", () => {
    expect(SettingsSchema.safeParse({ proxyHost: "0.0.0.0" }).success).toBe(
      false,
    )
  })
  it("rejects a non-integer proxyPort", () => {
    expect(SettingsSchema.safeParse({ proxyPort: 40.5 }).success).toBe(false)
  })
  it("defaults lastSelectedFolder to an empty string", () => {
    const settings = SettingsSchema.parse({})
    expect(settings.lastSelectedFolder).toBe("")
  })

  it("accepts a provided lastSelectedFolder", () => {
    const settings = SettingsSchema.parse({
      lastSelectedFolder: "/home/me/proj",
    })
    expect(settings.lastSelectedFolder).toBe("/home/me/proj")
  })

  it("defaults lastSelectedHarnessId to an empty string", () => {
    const settings = SettingsSchema.parse({})
    expect(settings.lastSelectedHarnessId).toBe("")
  })

  it("accepts a provided lastSelectedHarnessId", () => {
    const settings = SettingsSchema.parse({
      lastSelectedHarnessId: "claude",
    })
    expect(settings.lastSelectedHarnessId).toBe("claude")
  })

  it("no longer accepts the removed lastSelectedModelId key (strict)", () => {
    const parsed = SettingsSchema.safeParse({
      lastSelectedModelId: "mdl_1",
    })
    expect(parsed.success).toBe(false)
  })

  it("defaults lastByHarness to an empty object", () => {
    expect(SettingsSchema.parse({}).lastByHarness).toEqual({})
  })

  it("accepts a per-harness prefs map with a stored mode", () => {
    const parsed = SettingsSchema.parse({
      lastByHarness: { claude: { mode: "plan" } },
    })
    expect(parsed.lastByHarness.claude?.mode).toBe("plan")
  })

  it("accepts a per-harness modelId alongside mode", () => {
    const parsed = SettingsSchema.parse({
      lastByHarness: { claude: { mode: "plan", modelId: "mdl_x" } },
    })
    expect(parsed.lastByHarness.claude?.modelId).toBe("mdl_x")
  })

  it("rejects unknown keys inside a HarnessPrefs entry (strict)", () => {
    expect(
      SettingsSchema.safeParse({ lastByHarness: { claude: { nope: 1 } } })
        .success,
    ).toBe(false)
  })

  it("defaults updateChannel to stable and dismissedUpdateVersion to null", () => {
    const s = SettingsSchema.parse({})
    expect(s.updateChannel).toBe("stable")
    expect(s.dismissedUpdateVersion).toBeNull()
  })

  it("defaults dismissedUpdateHash to null and accepts a hash string", () => {
    const s = SettingsSchema.parse({})
    expect(s.dismissedUpdateHash).toBeNull()
    const withHash = SettingsSchema.parse({
      dismissedUpdateHash: "1wg7wj2g0bm4w",
    })
    expect(withHash.dismissedUpdateHash).toBe("1wg7wj2g0bm4w")
  })

  it("accepts canary as an update channel", () => {
    expect(
      SettingsSchema.parse({ updateChannel: "canary" }).updateChannel,
    ).toBe("canary")
  })

  it("rejects an unknown update channel", () => {
    expect(SettingsSchema.safeParse({ updateChannel: "beta" }).success).toBe(
      false,
    )
  })
})

describe("ConfigSchema", () => {
  it("parses a valid config with one provider, one model, and settings", () => {
    const config = {
      version: CURRENT_CONFIG_VERSION,
      providers: [validProvider],
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
        updateChannel: "stable",
        dismissedUpdateVersion: null,
        dismissedUpdateHash: null,
        firstTokenTimeoutMs: 120000,
        interTokenTimeoutMs: 60000,
        windowBounds: null,
        sessionNameModelId: null,
      },
    }
    expect(ConfigSchema.parse(config)).toEqual(config)
  })

  it("rejects a provider whose secret is an inline raw string instead of a SecretRef", () => {
    const config = {
      version: CURRENT_CONFIG_VERSION,
      providers: [
        { ...validProvider, secrets: { apiKey: "sk-raw-inline-key" } },
      ],
      models: [],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    expect(ConfigSchema.safeParse(config).success).toBe(false)
  })
  it("rejects unknown top-level fields", () => {
    expect(
      ConfigSchema.safeParse({
        version: CURRENT_CONFIG_VERSION,
        providers: [],
        models: [],
        settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

describe("SettingsSchema timeout fields", () => {
  it("defaults firstTokenTimeoutMs to 120000 and interTokenTimeoutMs to 60000", () => {
    const s = SettingsSchema.parse({})
    expect(s.firstTokenTimeoutMs).toBe(120000)
    expect(s.interTokenTimeoutMs).toBe(60000)
  })

  it("rejects a firstTokenTimeoutMs below the 5000ms floor", () => {
    const result = SettingsSchema.safeParse({ firstTokenTimeoutMs: 100 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "too_small")).toBe(true)
    }
  })

  it("rejects an interTokenTimeoutMs below the 1000ms floor", () => {
    const result = SettingsSchema.safeParse({ interTokenTimeoutMs: 500 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "too_small")).toBe(true)
    }
  })

  it("accepts an old config that omits the timeout fields (additive defaults, no migration)", () => {
    const s = SettingsSchema.parse({ proxyPort: 4000, proxyHost: "127.0.0.1" })
    expect(s.firstTokenTimeoutMs).toBe(120000)
  })
})

describe("defaultConfig", () => {
  it("returns the current version, empty providers/models, and loopback defaults", () => {
    expect(defaultConfig()).toEqual({
      version: CURRENT_CONFIG_VERSION,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1",
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        collapsedProjects: [],
        lastByHarness: {},
        updateChannel: "stable",
        dismissedUpdateVersion: null,
        dismissedUpdateHash: null,
        firstTokenTimeoutMs: 120000,
        interTokenTimeoutMs: 60000,
        windowBounds: null,
        sessionNameModelId: null,
      },
    })
  })
  it("produces a config that satisfies ConfigSchema", () => {
    expect(ConfigSchema.safeParse(defaultConfig()).success).toBe(true)
  })
  it("uses the bumped CURRENT_CONFIG_VERSION of 13", () => {
    expect(CURRENT_CONFIG_VERSION).toBe(13)
  })
})

describe("SettingsSchema sessionNameModelId", () => {
  it("defaults to null when absent", () => {
    const parsed = SettingsSchema.parse({})
    expect(parsed.sessionNameModelId).toBeNull()
  })

  it("accepts a string id", () => {
    const parsed = SettingsSchema.parse({ sessionNameModelId: "mdl_abc" })
    expect(parsed.sessionNameModelId).toBe("mdl_abc")
  })

  it("rejects non-string non-null values", () => {
    expect(() => SettingsSchema.parse({ sessionNameModelId: 123 })).toThrow()
    expect(() => SettingsSchema.parse({ sessionNameModelId: true })).toThrow()
  })

  it("exposes the bumped current config version", () => {
    expect(CURRENT_CONFIG_VERSION).toBe(13)
  })

  it("defaults the new field in defaultConfig()", () => {
    expect(defaultConfig().settings.sessionNameModelId).toBeNull()
    expect(defaultConfig().version).toBe(13)
  })
})
