import { type Result, ok, err } from "@launchkit/utils"
import type { Provider } from "@launchkit/types"
import type { SecretStore } from "@launchkit/secrets"
import type { ProxyError } from "../types"

export type ModelHandle = unknown

export interface SdkModule { create(config: Record<string, unknown>): unknown }
export type LoadSdk = (sdkProvider: string) => Promise<SdkModule>

export interface ProviderFactory {
  getModel(provider: Provider, providerModel: string): Promise<Result<ModelHandle, ProxyError>>
}

export const createProviderFactory = (deps: { secretStore: SecretStore; loadSdk: LoadSdk }): ProviderFactory => {
  const instanceCache = new Map<string, unknown>()

  const resolveSecrets = async (provider: Provider): Promise<Result<Record<string, string>, ProxyError>> => {
    const out: Record<string, string> = {}
    for (const [field, ref] of Object.entries(provider.secrets)) {
      const got = await deps.secretStore.get(ref)
      if (!got.ok) return err({ kind: "provider-failed", detail: `secret ${field} unavailable` })
      out[field] = got.value
    }
    return ok(out)
  }

  return {
    getModel: async (provider, providerModel) => {
      const secrets = await resolveSecrets(provider)
      if (!secrets.ok) return secrets
      const cacheKey = JSON.stringify({ s: provider.sdkProvider, c: provider.config, r: provider.secrets })
      let instance = instanceCache.get(cacheKey)
      if (instance === undefined) {
        let mod: SdkModule
        try { mod = await deps.loadSdk(provider.sdkProvider) }
        catch { return err({ kind: "unsupported-provider", sdkProvider: provider.sdkProvider }) }
        instance = mod.create({ ...provider.config, ...secrets.value })
        instanceCache.set(cacheKey, instance)
      }
      const inst = instance as (id: string) => unknown
      return ok(typeof inst === "function" ? inst(providerModel) : instance)
    },
  }
}
