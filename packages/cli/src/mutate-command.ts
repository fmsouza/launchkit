import type { Config } from "@spectrum/config"
import {
  type ModelRoute,
  ModelRouteSchema,
  type Provider,
  ProviderKeySchema,
  ProviderSchema,
} from "@spectrum/types"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"

/** Pull a required string flag, or report a usage error naming it. */
const requireFlag = (
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): Result<string, CliError> => {
  const value = flags[name]
  return typeof value === "string" && value.length > 0
    ? ok(value)
    : err({ kind: "usage", detail: `missing required flag --${name}` })
}

/** Split a comma list flag into trimmed, non-empty entries (empty array when absent). */
const splitModels = (
  flags: Readonly<Record<string, string | boolean>>,
): readonly string[] => {
  const value = flags.model
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

/**
 * Parse `--env K=V,K2=V2` into a string map. Splits on `,`, then each entry on the
 * FIRST `=` (values may contain `=`); trims the key; drops entries with an empty key
 * or no `=`. Returns `{}` when the flag is absent or a bare boolean.
 */
export const splitEnv = (
  flags: Readonly<Record<string, string | boolean>>,
): Record<string, string> => {
  const value = flags.env
  if (typeof value !== "string") return {}
  const out: Record<string, string> = {}
  for (const entry of value.split(",")) {
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    const key = entry.slice(0, eq).trim()
    if (key.length === 0) continue
    out[key] = entry.slice(eq + 1)
  }
  return out
}

const saveOrFail = async (
  deps: CliDeps,
  next: Config,
): Promise<Result<void, CliError>> => {
  const saved = await deps.config.save(next)
  return isErr(saved)
    ? err({ kind: "failed", detail: "could not save config" })
    : ok(undefined)
}

const addProvider = async (
  deps: CliDeps,
  config: Config,
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const id = requireFlag(flags, "id")
  if (isErr(id)) return id
  const name = requireFlag(flags, "name")
  if (isErr(name)) return name
  const sdk = requireFlag(flags, "sdk")
  if (isErr(sdk)) return sdk

  const sdkParsed = ProviderKeySchema.safeParse(sdk.value)
  if (!sdkParsed.success) {
    return err({
      kind: "usage",
      detail: `unknown --sdk provider: ${sdk.value}`,
    })
  }
  if (config.providers.some((p) => p.id === id.value)) {
    return err({
      kind: "failed",
      detail: `provider already exists: ${id.value}`,
    })
  }

  // SECURITY: secrets start EMPTY — the CLI never sets secret values (the GUI does via
  // setProviderSecret). Validate through ProviderSchema so the branded id is constructed
  // from one source of truth and a bad shape is rejected before save.
  const candidate = ProviderSchema.safeParse({
    id: id.value,
    name: name.value,
    sdkProvider: sdkParsed.data,
    config: {},
    secrets: {},
    models: splitModels(flags),
  })
  if (!candidate.success) {
    return err({ kind: "usage", detail: candidate.error.message })
  }
  const provider: Provider = candidate.data

  return saveOrFail(deps, {
    ...config,
    providers: [...config.providers, provider],
  })
}

const addModel = async (
  deps: CliDeps,
  config: Config,
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const provider = requireFlag(flags, "provider")
  if (isErr(provider)) return provider
  const model = requireFlag(flags, "model")
  if (isErr(model)) return model

  const aliasesRaw = flags.aliases
  const aliases =
    typeof aliasesRaw === "string"
      ? aliasesRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : []
  const candidate = ModelRouteSchema.safeParse({
    id: `mdl_${crypto.randomUUID()}`,
    providerId: provider.value,
    providerModel: model.value,
    aliases,
  })
  if (!candidate.success) {
    return err({ kind: "usage", detail: candidate.error.message })
  }
  const route: ModelRoute = candidate.data
  return saveOrFail(deps, { ...config, models: [...config.models, route] })
}

/** `add provider …` / `add model …`. */
export const add = async (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })

  const target = rest[0]
  switch (target) {
    case "provider":
      return addProvider(deps, loaded.value, flags)
    case "model":
      return addModel(deps, loaded.value, flags)
    default:
      return err({ kind: "usage", detail: "add <provider|model> --…" })
  }
}

const removeProvider = async (
  deps: CliDeps,
  config: Config,
  id: string | undefined,
): Promise<Result<void, CliError>> => {
  if (id === undefined)
    return err({ kind: "usage", detail: "remove provider <id>" })
  const next = config.providers.filter((p) => p.id !== id)
  if (next.length === config.providers.length) {
    return err({ kind: "failed", detail: `unknown provider: ${id}` })
  }
  return saveOrFail(deps, { ...config, providers: next })
}

const removeModel = async (
  deps: CliDeps,
  config: Config,
  id: string | undefined,
): Promise<Result<void, CliError>> => {
  if (id === undefined)
    return err({ kind: "usage", detail: "remove model <id>" })
  const next = config.models.filter((m) => m.id !== id)
  if (next.length === config.models.length) {
    return err({ kind: "failed", detail: `unknown model: ${id}` })
  }
  return saveOrFail(deps, { ...config, models: next })
}

/** `remove provider <id>` / `remove model <id>`. */
export const remove = async (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => {
  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })

  const target = rest[0]
  switch (target) {
    case "provider":
      return removeProvider(deps, loaded.value, rest[1])
    case "model":
      return removeModel(deps, loaded.value, rest[1])
    default:
      return err({
        kind: "usage",
        detail: "remove <provider|model> <id>",
      })
  }
}
