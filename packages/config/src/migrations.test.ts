import { describe, expect, it } from "bun:test"
import type { ModelId, ProviderId } from "@spectrum/types"
import { isOk } from "@spectrum/utils"
import { migrations, runMigrations } from "./migrations"
import { CURRENT_CONFIG_VERSION, ConfigSchema } from "./schema"

// A realistic v1 document: providers carried their key inline, no `secrets` field, no settings.
const v1Config = {
  version: 1,
  providers: [
    {
      id: "p_openai",
      name: "OpenAI",
      sdkProvider: "openai",
      apiKey: "sk-legacy-inline-key",
      config: { baseUrl: "https://api.openai.com/v1" },
      models: ["gpt-4o"],
    },
  ],
  aliases: [{ alias: "fast", providerId: "p_openai", providerModel: "gpt-4o" }],
}

describe("migrations", () => {
  it("ships ordered v1->v2, v2->v3, v3->v4, v4->v5, v5->v6, v6->v7, v7->v8, v8->v9, v9->v10, v10->v11, v11->v12, and v12->v13 migrations", () => {
    expect(migrations).toHaveLength(12)
    expect(migrations[0]?.from).toBe(1)
    expect(migrations[0]?.to).toBe(2)
    expect(migrations[1]?.from).toBe(2)
    expect(migrations[1]?.to).toBe(3)
    expect(migrations[2]?.from).toBe(3)
    expect(migrations[2]?.to).toBe(4)
    expect(migrations[3]?.from).toBe(4)
    expect(migrations[3]?.to).toBe(5)
    expect(migrations[4]?.from).toBe(5)
    expect(migrations[4]?.to).toBe(6)
    expect(migrations[5]?.from).toBe(6)
    expect(migrations[5]?.to).toBe(7)
    expect(migrations[6]?.from).toBe(7)
    expect(migrations[6]?.to).toBe(8)
    expect(migrations[7]?.from).toBe(8)
    expect(migrations[7]?.to).toBe(9)
    expect(migrations[8]?.from).toBe(9)
    expect(migrations[8]?.to).toBe(10)
    expect(migrations[9]?.from).toBe(10)
    expect(migrations[9]?.to).toBe(11)
    expect(migrations[10]?.from).toBe(11)
    expect(migrations[10]?.to).toBe(12)
    expect(migrations[11]?.from).toBe(12)
    expect(migrations[11]?.to).toBe(13)
  })
})

describe("runMigrations", () => {
  it("migrates a v1 config to v2 by moving inline keys to secret refs", () => {
    const result = runMigrations(v1Config)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    const provider = result.value.providers[0]
    expect(provider?.secrets).toEqual({})
    // The inline `apiKey` string is gone — it is not part of the validated Provider shape.
    expect((provider as Record<string, unknown>).apiKey).toBeUndefined()
    expect("profiles" in result.value).toBe(false)
  })

  it("passes an already-current config through and validates it", () => {
    const current = {
      version: CURRENT_CONFIG_VERSION,
      providers: [],
      models: [],
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
    expect(runMigrations(current)).toEqual({ ok: true, value: current })
  })

  it("migrates a v2 config through the chain and drops profiles by the current version", () => {
    const v2Config = {
      version: 2,
      providers: [],
      aliases: [],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" as const },
    }
    const result = runMigrations(v2Config)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect("profiles" in result.value).toBe(false)
  })

  it("strips a legacy profiles array carried up from v2 by the current version", () => {
    const v2WithProfiles = {
      version: 2,
      providers: [],
      aliases: [],
      profiles: [
        {
          id: "pr_default",
          name: "Default",
          harnessId: "claude",
          alias: "fast",
          env: {},
        },
      ],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" as const },
    }
    const result = runMigrations(v2WithProfiles)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect("profiles" in result.value).toBe(false)
  })

  it("returns migration-failed when version is newer than CURRENT", () => {
    const future = {
      version: CURRENT_CONFIG_VERSION + 1,
      providers: [],
      aliases: [],
      settings: {},
    }
    const result = runMigrations(future)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })

  it("returns migration-failed when version is missing or not a number", () => {
    const result = runMigrations({ providers: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })

  it("validates the result after migrating and fails on a shape error", () => {
    // v1 provider with an invalid sdkProvider survives the migration but must fail ConfigSchema.
    const broken = {
      ...v1Config,
      providers: [
        { ...v1Config.providers[0], sdkProvider: "not-a-real-provider" },
      ],
    }
    const result = runMigrations(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })

  it("migrates a v6 config to v7, adding an empty lastByHarness", () => {
    const v6 = {
      version: 6,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        lastSelectedModelId: "",
        collapsedProjects: [],
      },
    }
    const result = runMigrations(v6)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.settings.lastByHarness).toEqual({})
  })
})

describe("v3 → v4 (aliases → models)", () => {
  it("converts aliases to models keyed by the old alias name and drops profiles by the current version", () => {
    const raw = {
      version: 3,
      providers: [],
      aliases: [
        { alias: "fast", providerId: "openai", providerModel: "gpt-4o-mini" },
      ],
      profiles: [
        { id: "p1", name: "Fast", harnessId: "claude", alias: "fast", env: {} },
      ],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    const result = runMigrations(raw)
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.models).toEqual([
      {
        id: "fast" as ModelId,
        providerId: "openai" as ProviderId,
        providerModel: "gpt-4o-mini",
        aliases: [],
        attachments: {},
      },
    ])
    expect("profiles" in result.value).toBe(false)
    expect("aliases" in result.value).toBe(false)
  })

  it("yields empty models when there are no aliases", () => {
    const raw = {
      version: 3,
      providers: [],
      aliases: [],
      profiles: [],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    const result = runMigrations(raw)
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.value.models).toEqual([])
  })
})

describe("v4 → v5 (drop profiles)", () => {
  it("v4→v5 strips the profiles field so the strict schema accepts the doc", () => {
    const raw = {
      version: 4,
      providers: [],
      models: [],
      profiles: [{ id: "pr_1", name: "Fast", harnessId: "claude", env: {} }],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
      expect("profiles" in result.value).toBe(false)
    }
  })
})

describe("v8 → v9 (ollama → custom)", () => {
  it("rewrites an ollama provider to custom and normalizes baseUrl to a /v1 serverUrl", () => {
    const raw = {
      version: 8,
      providers: [
        {
          id: "p_1",
          name: "Local",
          sdkProvider: "ollama",
          config: { baseUrl: "http://localhost:11434" },
          secrets: {},
          models: [],
        },
      ],
      models: [],
      settings: {},
    }
    const r = runMigrations(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const p = r.value.providers[0]
      expect(p?.sdkProvider).toBe("custom")
      expect(p?.config).toEqual({ serverUrl: "http://localhost:11434/v1" })
    }
  })

  it("seeds a default /v1 serverUrl when the ollama provider had no baseUrl", () => {
    const raw = {
      version: 8,
      providers: [
        {
          id: "p_2",
          name: "Local",
          sdkProvider: "ollama",
          config: {},
          secrets: {},
          models: [],
        },
      ],
      models: [],
      settings: {},
    }
    const r = runMigrations(raw)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.providers[0]?.config).toEqual({
        serverUrl: "http://localhost:11434/v1",
      })
  })

  it("does not append /v1 when the baseUrl already ends with it", () => {
    const raw = {
      version: 8,
      providers: [
        {
          id: "p_3",
          name: "Local",
          sdkProvider: "ollama",
          config: { baseUrl: "http://host:1234/v1" },
          secrets: {},
          models: [],
        },
      ],
      models: [],
      settings: {},
    }
    const r = runMigrations(raw)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.providers[0]?.config).toEqual({
        serverUrl: "http://host:1234/v1",
      })
  })
})

describe("v9 → v10 (updateChannel + dismissedUpdateVersion)", () => {
  it("migrates a v9 document to v10 with default update settings", () => {
    const v9 = {
      version: 9,
      providers: [],
      models: [],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    const result = runMigrations(v9)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.settings.updateChannel).toBe("stable")
    expect(result.value.settings.dismissedUpdateVersion).toBeNull()
  })
})

describe("v10 → v11 (models[].aliases)", () => {
  it("migrates a v10 config to v11, defaulting model aliases to []", () => {
    const raw = {
      version: 10,
      providers: [
        {
          id: "p1",
          name: "P1",
          sdkProvider: "openai",
          config: {},
          secrets: {},
          models: [],
        },
      ],
      models: [{ id: "mdl_a", providerId: "p1", providerModel: "gpt-4o" }],
      settings: {},
    }
    const r = runMigrations(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.version).toBe(CURRENT_CONFIG_VERSION)
      expect(r.value.models[0]?.aliases).toEqual([])
    }
  })
})

describe("v7 → v8 (fold lastSelectedModelId into lastByHarness)", () => {
  it("folds the legacy lastSelectedModelId into lastByHarness[lastSelectedHarnessId] and drops it", () => {
    const raw = {
      version: 7,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "claude",
        lastSelectedModelId: "mdl_x",
        collapsedProjects: [],
        lastByHarness: {},
      },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    const settings = result.value.settings as Record<string, unknown>
    expect(settings.lastByHarness).toEqual({ claude: { modelId: "mdl_x" } })
    // The legacy top-level key is gone.
    expect("lastSelectedModelId" in settings).toBe(false)
  })

  it("preserves an existing lastByHarness entry's mode when folding in the legacy modelId", () => {
    const raw = {
      version: 7,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "claude",
        lastSelectedModelId: "mdl_x",
        collapsedProjects: [],
        lastByHarness: { claude: { mode: "plan" } },
      },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.lastByHarness).toEqual({
      claude: { mode: "plan", modelId: "mdl_x" },
    })
  })

  it("does not fold when lastSelectedHarnessId is empty (no harness to attribute the model to)", () => {
    const raw = {
      version: 7,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        lastSelectedModelId: "mdl_x",
        collapsedProjects: [],
        lastByHarness: {},
      },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.lastByHarness).toEqual({})
    const settings = result.value.settings as Record<string, unknown>
    expect("lastSelectedModelId" in settings).toBe(false)
  })

  it("does not fold when lastSelectedModelId is empty", () => {
    const raw = {
      version: 7,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "claude",
        lastSelectedModelId: "",
        collapsedProjects: [],
        lastByHarness: {},
      },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.lastByHarness).toEqual({})
  })
})

describe("v11 → v12 (add settings.windowBounds)", () => {
  it("adds windowBounds defaulting to null when migrating a v11 config", () => {
    const raw = {
      version: 11,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        collapsedProjects: [],
        lastByHarness: {},
        updateChannel: "stable",
        dismissedUpdateVersion: null,
        dismissedUpdateHash: null,
        firstTokenTimeoutMs: 120000,
        interTokenTimeoutMs: 60000,
      },
    }
    const result = runMigrations(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.settings.windowBounds).toBeNull()
  })
})

describe("v12 → v13 migration (sessionNameModelId)", () => {
  it("migrates a v12 doc to v13 with the new field defaulted to null", () => {
    const v12 = {
      version: 12,
      providers: [],
      models: [],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    }
    const migrated = runMigrations(v12 as Record<string, unknown>)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value.version).toBe(CURRENT_CONFIG_VERSION)
    // round-trips through ConfigSchema
    const parsed = ConfigSchema.parse(migrated.value)
    expect(parsed.settings.sessionNameModelId).toBeNull()
  })

  it("preserves an existing v13 doc with a set id unchanged", () => {
    const v13 = {
      version: 13,
      providers: [],
      models: [],
      settings: {
        proxyPort: 4000,
        proxyHost: "127.0.0.1",
        sessionNameModelId: "mdl_xyz",
      },
    }
    const migrated = runMigrations(v13 as Record<string, unknown>)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    const parsed = ConfigSchema.parse(migrated.value)
    expect(parsed.settings.sessionNameModelId).toBe("mdl_xyz")
  })
})
