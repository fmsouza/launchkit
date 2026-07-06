import type { Config } from "@spectrum/config"
import type { Provider } from "@spectrum/types"
import { WIRE_ALIAS_PREFIX } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { ProxyError } from "./types"

export type ResolvedRoute = {
  readonly provider: Provider
  readonly providerModel: string
  readonly routeId: string
  readonly resolvedVia:
    | "exact"
    | "alias"
    | "provider-model"
    | "session-fallback"
    | "wire-alias"
}

// Well-known model "family" keywords. A requested id is reduced to the FIRST family keyword it
// contains (case-insensitive); a route claims a family/tier by listing the keyword in `aliases`.
const FAMILY_KEYWORDS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "gpt-5",
  "gpt-4",
  "o4",
  "o3",
  "mini",
  "nano",
  "flash",
  "pro",
] as const

const familyOf = (id: string): string | undefined => {
  const lower = id.toLowerCase()
  return FAMILY_KEYWORDS.find((kw) => lower.includes(kw))
}

export interface Router {
  /** Resolve a request's model id to its provider and provider-native model. */
  resolve(
    id: string,
    opts?: { readonly fallbackModelId?: string },
  ): Result<ResolvedRoute, ProxyError>
}

type ModelRoute = Config["models"][number]

const toResolved = (
  config: Config,
  route: ModelRoute,
  resolvedVia: ResolvedRoute["resolvedVia"],
): Result<ResolvedRoute, ProxyError> => {
  const provider = config.providers.find(
    (p) => (p.id as string) === (route.providerId as string),
  )
  if (provider === undefined)
    return err({
      kind: "unknown-provider",
      providerId: route.providerId as string,
    })
  return ok({
    provider,
    providerModel: route.providerModel,
    routeId: route.id as string,
    resolvedVia,
  })
}

const resolveIn = (
  config: Config,
  id: string,
  fallbackModelId: string | undefined,
): Result<ResolvedRoute, ProxyError> => {
  // 0. Wire alias: the harness CLI was handed `claude-spectrum-<routeId>` so it treats the
  //    model as multimodal-capable and ships real image/PDF blocks. Strip back to the exact
  //    route so the proxy runs against the user's selected model.
  if (id.startsWith(WIRE_ALIAS_PREFIX)) {
    const suffix = id.slice(WIRE_ALIAS_PREFIX.length)
    const viaWire = config.models.find((x) => (x.id as string) === suffix)
    if (viaWire !== undefined) return toResolved(config, viaWire, "wire-alias")
    // Unknown suffix: fall through — the full id still participates in the
    // alias/family/fallback chain below.
  }

  // 1. Exact route-id match (preserves explicit multi-route setups).
  const exact = config.models.find((x) => (x.id as string) === id)
  if (exact !== undefined) return toResolved(config, exact, "exact")

  // 2. Alias / tier match: a route the user marked with this alias (or with the requested id's
  //    family keyword) — lets a "haiku" sub-agent run on a dedicated cheap route, not the session model.
  const norm = id.toLowerCase()
  const fam = familyOf(id)
  const byAlias = config.models.find((x) =>
    (x.aliases ?? []).some((a) => {
      const al = a.toLowerCase()
      return al === norm || (fam !== undefined && al === fam)
    }),
  )
  if (byAlias !== undefined) return toResolved(config, byAlias, "alias")

  // 3. Provider-native match: the requested id IS some route's providerModel (e.g. a raw "gpt-4o").
  const byProviderModel = config.models.find((x) => x.providerModel === id)
  if (byProviderModel !== undefined)
    return toResolved(config, byProviderModel, "provider-model")

  // 4. Session fallback: route an unknown id (sub-agent / background / review) to the session's
  //    SELECTED model, decoded from the proxy token. Correct under concurrent multi-model sessions.
  if (fallbackModelId !== undefined) {
    const fb = config.models.find((x) => (x.id as string) === fallbackModelId)
    if (fb !== undefined) return toResolved(config, fb, "session-fallback")
  }

  return err({ kind: "unknown-model", id })
}

/**
 * Build a model router. Accepts either a static `Config` or a `() => Config` getter; the getter form
 * resolves against the LATEST config on every call. Resolution is tolerant: exact id → provider-native
 * model → the session's selected model (decoded from the proxy token) → unknown-model.
 */
export const createRouter = (source: Config | (() => Config)): Router => {
  const get = typeof source === "function" ? source : () => source
  return { resolve: (id, opts) => resolveIn(get(), id, opts?.fallbackModelId) }
}
