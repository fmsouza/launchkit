import { type Result, err, isErr, ok } from "@launchkit/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"

const LIST_TARGETS = ["harnesses", "providers", "aliases"] as const

const listHarnesses = async (
  deps: CliDeps,
): Promise<Result<void, CliError>> => {
  const listed = await deps.registry.list()
  if (isErr(listed))
    return err({ kind: "failed", detail: "could not list harnesses" })
  for (const h of listed.value) {
    deps.out.write(`${h.id}\t${h.name}\t(${h.apiFormat})`)
  }
  return ok(undefined)
}

const listProviders = async (
  deps: CliDeps,
): Promise<Result<void, CliError>> => {
  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })
  for (const p of loaded.value.providers) {
    // SECURITY: print only non-secret identity — never `p.secrets` (the keychain refs).
    deps.out.write(`${p.id}\t${p.name}\t[${p.sdkProvider}]`)
  }
  return ok(undefined)
}

const listAliases = async (deps: CliDeps): Promise<Result<void, CliError>> => {
  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })
  for (const a of loaded.value.aliases) {
    deps.out.write(`${a.alias}\t-> ${a.providerId} / ${a.providerModel}`)
  }
  return ok(undefined)
}

/** `list harnesses | providers | aliases`. */
export const list = async (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => {
  const target = rest[0]
  switch (target) {
    case "harnesses":
      return listHarnesses(deps)
    case "providers":
      return listProviders(deps)
    case "aliases":
      return listAliases(deps)
    default:
      return err({ kind: "usage", detail: `list <${LIST_TARGETS.join("|")}>` })
  }
}
