import type { ProviderDescriptor } from "@spectrum/providers"
import { type Result, ok } from "@spectrum/utils"
import type { ProxyError } from "../types"

/** Everything a base-url resolver may consult, without reaching around the factory. */
export type ResolveBaseUrlInput = {
  readonly descriptor: ProviderDescriptor
  readonly config: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
  /**
   * The factory's provider cache key, or `undefined` on the draft-probe path (an unsaved
   * provider). A supervising resolver keys one child process per instance, so it has nothing
   * to key on when this is absent.
   */
  readonly instanceKey: string | undefined
}

/**
 * Resolve the base url an SDK instance should be built against, ahead of the instance cache.
 * `undefined` means "no override": the config's `serverUrl` / the descriptor default apply
 * unchanged.
 */
export type ResolveBaseUrl = (
  input: ResolveBaseUrlInput,
) => Promise<Result<string | undefined, ProxyError>>

/**
 * The non-supervising default: never overrides. `buildSdkOptions` remains the single owner of
 * the `config.serverUrl ?? descriptor.sdkMapping.defaultBaseUrl` rule — duplicating it here
 * would create a second source of truth for every builtin provider.
 */
export const defaultResolveBaseUrl: ResolveBaseUrl = async () => ok(undefined)
