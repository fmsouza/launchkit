import { describe, expect, it } from "bun:test"
import type { ModelId, ProviderId } from "@spectrum/types"
import {
  CURRENT_CONFIG_VERSION,
  ConfigSchema,
  PluginInstallSchema,
  SettingsSchema,
  defaultConfig,
} from "./schema"

const validProvider = {
  id: "p_openai" as ProviderId,
  name: "OpenAI",
  sdkProvider: "openai" as const,
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
          id: "fast" as ModelId,
          providerId: "p_openai" as ProviderId,
          providerModel: "gpt-4o-mini",
          aliases: [],
        },
      ],
      settings: {
        proxyPort: 4000,
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
    const firstModel = config.models[0]
    if (firstModel === undefined) throw new Error("fixture missing first model")
    expect(ConfigSchema.parse(config)).toEqual({
      ...config,
      models: [{ ...firstModel, attachments: {} }],
      providerPlugins: [],
    })
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

  it("loads a legacy config whose models lack attachment capability fields", () => {
    // Pre-capability model entries must keep parsing (attachments defaults to {}).
    const parsed = ConfigSchema.safeParse({
      version: CURRENT_CONFIG_VERSION,
      providers: [validProvider],
      models: [
        {
          id: "mdl_00000000-0000-4000-8000-000000000000",
          providerId: "p_openai",
          providerModel: "kimi-k2.7-code",
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
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.models[0]?.attachments).toEqual({})
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
      providerPlugins: [],
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

describe("providerPlugins", () => {
  it("defaults to an empty array when a config omits the field", () => {
    const config = {
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
    }
    const parsed = ConfigSchema.safeParse(config)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.providerPlugins).toEqual([])
  })

  it("accepts a git-sourced install record", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "acme",
        source: {
          kind: "git",
          url: "https://github.com/acme/spectrum-plugin.git",
          ref: "main",
          commit: "abc1234",
        },
        enabled: true,
      }).success,
    ).toBe(true)
  })

  it("accepts a linked path install record", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "acme",
        source: { kind: "path", path: "/home/me/acme", linked: true },
        enabled: true,
      }).success,
    ).toBe(true)
  })

  it("accepts a copied path install record", () => {
    const parsed = PluginInstallSchema.safeParse({
      id: "acme-copy",
      source: { kind: "path", path: "/home/me/acme", linked: false },
      enabled: false,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.source).toEqual({
        kind: "path",
        path: "/home/me/acme",
        linked: false,
      })
    }
  })

  it("accepts a local hand-placed install record", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "handmade",
        source: { kind: "local" },
        enabled: true,
      }).success,
    ).toBe(true)
  })

  it("rejects an install record carrying an unknown source kind", () => {
    const parsed = PluginInstallSchema.safeParse({
      id: "acme",
      source: { kind: "npm", name: "spectrum-plugin-acme" },
      enabled: true,
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.join(".") === "source.kind"),
      ).toBe(true)
      expect(
        parsed.error.issues.some(
          (i) => i.code === "invalid_union_discriminator",
        ),
      ).toBe(true)
    }
  })

  it("rejects an install record carrying an unknown top-level key (strict)", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "acme",
        source: { kind: "local" },
        enabled: true,
        version: "1.0.0",
      }).success,
    ).toBe(false)
  })

  it("rejects a git source carrying an unknown key (strict)", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "acme",
        source: {
          kind: "git",
          url: "https://github.com/acme/spectrum-plugin.git",
          ref: "main",
          commit: "abc1234",
          branch: "main",
        },
        enabled: true,
      }).success,
    ).toBe(false)
  })

  it("rejects an uppercase plugin id", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "ACME",
        source: { kind: "local" },
        enabled: true,
      }).success,
    ).toBe(false)
  })

  it("rejects a plugin id starting with a dash", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "-acme",
        source: { kind: "local" },
        enabled: true,
      }).success,
    ).toBe(false)
  })

  it("rejects an empty plugin id", () => {
    expect(
      PluginInstallSchema.safeParse({
        id: "",
        source: { kind: "local" },
        enabled: true,
      }).success,
    ).toBe(false)
  })
})
