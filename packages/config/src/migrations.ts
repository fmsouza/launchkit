import { type Result, err, ok } from "@spectrum/utils"
import type { ConfigError } from "./errors"
import {
  CURRENT_CONFIG_VERSION,
  type Config,
  ConfigSchema,
  SettingsSchema,
} from "./schema"

/** A single forward step: take a raw doc at version `from` and return it shaped for version `to`. */
export type Migration = {
  readonly from: number
  readonly to: number
  readonly migrate: (raw: Record<string, unknown>) => Record<string, unknown>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}

/**
 * v1 stored each provider's API key inline as `provider.apiKey`. v2 moves secrets to the
 * keychain, so this strips the inline `apiKey` string and initialises `secrets: {}`
 * (the keychain reference is re-established later by `@spectrum/secrets`). It also fills a
 * default `settings` block, which v1 documents did not have.
 */
const v1ToV2: Migration = {
  from: 1,
  to: 2,
  migrate: (raw) => {
    const providers = Array.isArray(raw.providers) ? raw.providers : []
    const migratedProviders = providers.map((entry) => {
      // Shallow-copy, drop the legacy inline secret, and re-key secrets as an empty ref map.
      const { apiKey: _unused, ...rest } = asRecord(entry)
      void _unused
      const next: Record<string, unknown> = { ...rest, secrets: {} }
      return next
    })
    return {
      ...raw,
      version: 2,
      providers: migratedProviders,
      settings: SettingsSchema.parse(asRecord(raw.settings)),
    }
  },
}

/**
 * v3 introduces top-level `profiles`. Older documents have no such field, so this seeds
 * `profiles: []` when it is missing or not an array, and otherwise passes the existing
 * array through untouched. Validation against `ConfigSchema` happens after all steps run.
 */
const v2ToV3: Migration = {
  from: 2,
  to: 3,
  migrate: (raw) => ({
    ...raw,
    version: 3,
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
  }),
}

/**
 * v4 reframes "aliases" as "models": each alias becomes a ModelRoute whose opaque `id` is the
 * old alias name (already unique within a config, so profile references map without lookups).
 * Profiles' `alias` becomes `modelId`. The harness-level `defaultAlias` is gone entirely; a
 * "default" launch now bypasses the proxy and needs no stored handle.
 */
const v3ToV4: Migration = {
  from: 3,
  to: 4,
  migrate: (raw) => {
    const aliases = Array.isArray(raw.aliases) ? raw.aliases : []
    const models = aliases.map((entry) => {
      const a = asRecord(entry)
      return {
        id: a.alias,
        providerId: a.providerId,
        providerModel: a.providerModel,
      }
    })
    const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).map(
      (entry) => {
        const { alias, ...rest } = asRecord(entry)
        return alias === undefined ? rest : { ...rest, modelId: alias }
      },
    )
    const { aliases: _drop, ...rest } = raw
    void _drop
    return { ...rest, version: 4, models, profiles }
  },
}

/**
 * v5 removes the `profiles` feature entirely. Older documents may carry a top-level
 * `profiles` array; the strict `ConfigSchema` would now reject it, so this drops the key.
 */
const v4ToV5: Migration = {
  from: 4,
  to: 5,
  migrate: (raw) => {
    const { profiles: _drop, ...rest } = raw
    void _drop
    return { ...rest, version: 5 }
  },
}

/**
 * v6 adds `settings.collapsedProjects` (an array of project IDs that the user has
 * collapsed in the sidebar). The new field has a schema-level default of `[]`, so
 * documents that existed at v5 simply gain the field with an empty array on first
 * load. No data transformation is needed beyond bumping the version.
 */
const v5ToV6: Migration = {
  from: 5,
  to: 6,
  migrate: (raw) => ({ ...raw, version: 6 }),
}

/**
 * v7 adds `settings.lastByHarness` (per-harness "last used" prefs). The new field has a
 * schema-level default of `{}`, so v6 documents simply gain it on first load — no data
 * transformation beyond bumping the version (mirrors v5→v6).
 */
const v6ToV7: Migration = {
  from: 6,
  to: 7,
  migrate: (raw) => ({ ...raw, version: 7 }),
}

/**
 * v8 consolidates model selection: the modal no longer carries a model picker, and the
 * composer's per-harness model selector persists into `lastByHarness[].modelId`. The legacy
 * top-level `settings.lastSelectedModelId` is folded into the per-harness entry attributed by
 * `settings.lastSelectedHarnessId` and then dropped from the shape entirely. Documents that
 * already use `lastByHarness[].modelId` pass through with only the key-removal applied.
 */
const v7ToV8: Migration = {
  from: 7,
  to: 8,
  migrate: (raw) => {
    const settings = asRecord(raw.settings)
    const harnessId =
      typeof settings.lastSelectedHarnessId === "string"
        ? settings.lastSelectedHarnessId
        : ""
    const modelId =
      typeof settings.lastSelectedModelId === "string"
        ? settings.lastSelectedModelId
        : ""
    const lastByHarness = {
      ...(asRecord(settings.lastByHarness) as Record<
        string,
        Record<string, unknown>
      >),
    }
    if (harnessId !== "" && modelId !== "") {
      lastByHarness[harnessId] = {
        ...(lastByHarness[harnessId] ?? {}),
        modelId,
      }
    }
    const { lastSelectedModelId: _drop, ...restSettings } = settings
    void _drop
    return {
      ...raw,
      version: 8,
      settings: { ...restSettings, lastByHarness },
    }
  },
}

/**
 * v9 turns the legacy local-"Ollama" provider into the generic OpenAI-compatible
 * "custom" provider. Each `sdkProvider:"ollama"` entry becomes `"custom"`, and its
 * old Ollama-native `config.baseUrl` is moved to `config.serverUrl`, normalized to
 * the OpenAI-compatible `/v1` path (Ollama serves `/v1/chat/completions` + `/v1/models`).
 * Missing/blank URLs seed `http://localhost:11434/v1`. The legacy `baseUrl` key is dropped.
 * (The `"ollama"` provider key is reused for the new Ollama Cloud provider going forward.)
 */
const v8ToV9: Migration = {
  from: 8,
  to: 9,
  migrate: (raw) => {
    const providers = Array.isArray(raw.providers) ? raw.providers : []
    const migrated = providers.map((entry) => {
      const p = asRecord(entry)
      if (p.sdkProvider !== "ollama") return p
      const config = asRecord(p.config)
      const rawBase =
        typeof config.baseUrl === "string" && config.baseUrl !== ""
          ? config.baseUrl
          : "http://localhost:11434"
      const serverUrl = rawBase.endsWith("/v1") ? rawBase : `${rawBase}/v1`
      const { baseUrl: _drop, ...restConfig } = config
      void _drop
      return {
        ...p,
        sdkProvider: "custom",
        config: { ...restConfig, serverUrl },
      }
    })
    return { ...raw, version: 9, providers: migrated }
  },
}

/**
 * v10 adds `settings.updateChannel` (default "stable") and
 * `settings.dismissedUpdateVersion` (default null) for the in-app updater. Both
 * have schema-level defaults, so v9 documents simply gain them on first load —
 * no data transformation beyond bumping the version.
 */
const v9ToV10: Migration = {
  from: 9,
  to: 10,
  migrate: (raw) => ({ ...raw, version: 10 }),
}

/**
 * v11 adds `models[].aliases` (optional tier/alias labels for tolerant proxy routing). The new field
 * has a schema-level default of `[]`, so v10 documents simply gain it on first load — no data
 * transformation beyond bumping the version (mirrors v5→v6).
 */
const v10ToV11: Migration = {
  from: 10,
  to: 11,
  migrate: (raw) => ({ ...raw, version: 11 }),
}

/**
 * v12 adds `settings.windowBounds` (last-known main window geometry, or null).
 * The new field has a schema-level default of `null`, so v11 documents simply
 * gain it on first load — no data transformation beyond bumping the version
 * (mirrors v5→v6).
 */
const v11ToV12: Migration = {
  from: 11,
  to: 12,
  migrate: (raw) => ({ ...raw, version: 12 }),
}

/**
 * v13 adds `settings.sessionNameModelId` (the model id used to AI-generate
 * session names, or null = off). The schema default backfills the field on
 * parse, so this step is a version stamp only — same pattern as recent
 * additive migrations.
 */
const v12ToV13: Migration = {
  from: 12,
  to: 13,
  migrate: (raw) => ({ ...raw, version: 13 }),
}

/** Ordered list of forward migrations. Append a new step whenever `CURRENT_CONFIG_VERSION` bumps. */
export const migrations: readonly Migration[] = [
  v1ToV2,
  v2ToV3,
  v3ToV4,
  v4ToV5,
  v5ToV6,
  v6ToV7,
  v7ToV8,
  v8ToV9,
  v9ToV10,
  v10ToV11,
  v11ToV12,
  v12ToV13,
]

/**
 * Read `raw.version`, apply ordered migrations up to `CURRENT_CONFIG_VERSION`, then validate
 * with `ConfigSchema`. Returns `migration-failed` for an unknown/future version, a missing
 * migration step, or a validation failure after migrating.
 */
export const runMigrations = (raw: unknown): Result<Config, ConfigError> => {
  const doc = asRecord(raw)
  const version = doc.version

  if (typeof version !== "number" || !Number.isInteger(version)) {
    return err({
      kind: "migration-failed",
      detail: "config is missing a numeric version",
    })
  }
  if (version > CURRENT_CONFIG_VERSION) {
    return err({
      kind: "migration-failed",
      detail: `config version ${version} is newer than supported version ${CURRENT_CONFIG_VERSION}`,
    })
  }

  let current: Record<string, unknown> = doc
  let at = version
  while (at < CURRENT_CONFIG_VERSION) {
    const step = migrations.find((migration) => migration.from === at)
    if (step === undefined) {
      return err({
        kind: "migration-failed",
        detail: `no migration from version ${at}`,
      })
    }
    current = step.migrate(current)
    at = step.to
  }

  const parsed = ConfigSchema.safeParse(current)
  if (!parsed.success) {
    return err({ kind: "migration-failed", detail: parsed.error.message })
  }
  return ok(parsed.data)
}
