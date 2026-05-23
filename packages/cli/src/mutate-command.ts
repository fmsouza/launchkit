import type { Config } from "@launchkit/config"
import {
  type ModelAlias,
  ModelAliasSchema,
  type Provider,
  ProviderSchema,
  SdkProviderSchema,
} from "@launchkit/types"
import { type Result, err, isErr, ok } from "@launchkit/utils"
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

  const sdkParsed = SdkProviderSchema.safeParse(sdk.value)
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

const addAlias = async (
  deps: CliDeps,
  config: Config,
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const name = requireFlag(flags, "name")
  if (isErr(name)) return name
  const provider = requireFlag(flags, "provider")
  if (isErr(provider)) return provider
  const model = requireFlag(flags, "model")
  if (isErr(model)) return model

  const candidate = ModelAliasSchema.safeParse({
    alias: name.value,
    providerId: provider.value,
    providerModel: model.value,
  })
  if (!candidate.success) {
    return err({ kind: "usage", detail: candidate.error.message })
  }
  const alias: ModelAlias = candidate.data

  return saveOrFail(deps, { ...config, aliases: [...config.aliases, alias] })
}

/** `add provider …` / `add alias …`. */
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
    case "alias":
      return addAlias(deps, loaded.value, flags)
    default:
      return err({ kind: "usage", detail: "add <provider|alias> --…" })
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

const removeAlias = async (
  deps: CliDeps,
  config: Config,
  name: string | undefined,
): Promise<Result<void, CliError>> => {
  if (name === undefined)
    return err({ kind: "usage", detail: "remove alias <name>" })
  const next = config.aliases.filter((a) => a.alias !== name)
  if (next.length === config.aliases.length) {
    return err({ kind: "failed", detail: `unknown alias: ${name}` })
  }
  return saveOrFail(deps, { ...config, aliases: next })
}

/** `remove provider <id>` / `remove alias <name>`. */
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
    case "alias":
      return removeAlias(deps, loaded.value, rest[1])
    default:
      return err({ kind: "usage", detail: "remove <provider|alias> <id>" })
  }
}
