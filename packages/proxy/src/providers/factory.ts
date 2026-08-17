import type { ProviderDescriptor } from "@spectrum/providers"
import type { SecretStore } from "@spectrum/secrets"
import type { Provider } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { ProxyError } from "../types"
import { buildSdkOptions } from "./build-sdk-options"
import type { ResolveBaseUrl } from "./resolve-base-url"

export type ModelHandle = unknown

export interface SdkModule {
  create(config: Record<string, unknown>): unknown
}
export type LoadSdk = (descriptor: ProviderDescriptor) => Promise<SdkModule>

export interface ProviderFactory {
  getModel(
    provider: Provider,
    providerModel: string,
  ): Promise<Result<ModelHandle, ProxyError>>
  getModelFromResolved(input: {
    sdkProvider: string
    config: Readonly<Record<string, string>>
    secrets: Readonly<Record<string, string>>
    providerModel: string
  }): Promise<Result<ModelHandle, ProxyError>>
}

export const createProviderFactory = (deps: {
  secretStore: SecretStore
  loadSdk: LoadSdk
  /** Resolve a provider key to its descriptor. Injected so plugin providers resolve too. */
  getDescriptor: (key: string) => ProviderDescriptor | undefined
  /**
   * Resolve the base url to build against. Injected so a supervised plugin's live port reaches
   * the SDK options; `defaultResolveBaseUrl` is the non-supervising identity.
   */
  resolveBaseUrl: ResolveBaseUrl
}): ProviderFactory => {
  const instanceCache = new Map<string, unknown>()

  const resolveSecrets = async (
    provider: Provider,
  ): Promise<Result<Record<string, string>, ProxyError>> => {
    const out: Record<string, string> = {}
    for (const [field, ref] of Object.entries(provider.secrets)) {
      const got = await deps.secretStore.get(ref)
      if (!got.ok)
        return err({
          kind: "provider-failed",
          detail: `secret ${field} unavailable`,
        })
      out[field] = got.value
    }
    return ok(out)
  }

  // Shared build core: SDK instance from sdkProvider+config+RESOLVED secrets, then invoke for the model.
  const buildFromResolved = async (
    sdkProvider: string,
    config: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
    providerModel: string,
    cacheKey: string | undefined,
  ): Promise<Result<ModelHandle, ProxyError>> => {
    // Descriptor lookup and base-URL resolution BOTH precede the cache read: the resolved URL
    // is part of the cache key, so reading the cache first would serve an instance pointed at a
    // dead port after a supervised plugin restarts. Resolution therefore runs on every call —
    // a pure function for builtins, a cheap already-running check for a supervised plugin.
    const descriptor = deps.getDescriptor(sdkProvider)
    if (descriptor === undefined)
      return err({ kind: "unsupported-provider", sdkProvider })

    const base = await deps.resolveBaseUrl({
      descriptor,
      config,
      secrets,
      instanceKey: cacheKey,
    })
    if (!base.ok) return base

    const effectiveConfig =
      base.value === undefined ? config : { ...config, serverUrl: base.value }
    const effectiveCacheKey =
      cacheKey === undefined ? undefined : `${cacheKey}|${base.value ?? ""}`

    let instance =
      effectiveCacheKey !== undefined
        ? instanceCache.get(effectiveCacheKey)
        : undefined
    if (instance === undefined) {
      let mod: SdkModule
      try {
        mod = await deps.loadSdk(descriptor)
      } catch {
        return err({ kind: "unsupported-provider", sdkProvider })
      }
      instance = mod.create(
        buildSdkOptions(descriptor, effectiveConfig, secrets),
      )
      if (effectiveCacheKey !== undefined)
        instanceCache.set(effectiveCacheKey, instance)
    }
    const inst = instance as (id: string) => unknown
    return ok(typeof inst === "function" ? inst(providerModel) : instance)
  }

  return {
    getModel: async (provider, providerModel) => {
      const secrets = await resolveSecrets(provider)
      if (!secrets.ok) return secrets
      const cacheKey = JSON.stringify({
        s: provider.sdkProvider,
        c: provider.config,
        r: provider.secrets,
      })
      return buildFromResolved(
        provider.sdkProvider,
        provider.config,
        secrets.value,
        providerModel,
        cacheKey,
      )
    },
    // Draft path: secrets already resolved (never persisted). One-shot → bypass the cache
    // so no secret VALUE is ever used as a cache key.
    getModelFromResolved: async ({
      sdkProvider,
      config,
      secrets,
      providerModel,
    }) =>
      buildFromResolved(sdkProvider, config, secrets, providerModel, undefined),
  }
}
