import { isPluginKey } from "@spectrum/types"
import { listDescriptors, toCatalogEntry } from "./catalog"
import type { ProviderCatalogEntry, ProviderDescriptor } from "./types"

export interface ProviderRegistry {
  /** The descriptor for a key, or undefined when nothing claims it. */
  get(key: string): ProviderDescriptor | undefined
  /** Every descriptor: builtins first, then registered plugins. */
  list(): readonly ProviderDescriptor[]
  /** The presentational, IPC-safe projection of `list()`. */
  catalog(): readonly ProviderCatalogEntry[]
}

/**
 * Build a provider registry over the builtin catalog plus zero or more plugin descriptors.
 *
 * A plugin descriptor whose key is not `plugin:`-prefixed is DISCARDED — a plugin may never
 * claim or shadow a builtin key. Duplicate plugin keys resolve first-wins. That tiebreak is
 * NOT the enforcement point and must not be relied on: `@spectrum/extensions` refuses a
 * duplicate contribution id outright, because first-wins here would still leave the SUPERVISOR
 * free to spawn the loser's launch block for the winner's key.
 *
 * `createProviderRegistry()` with no plugins is behaviourally identical to the previous
 * static catalog.
 */
export const createProviderRegistry = (
  plugins: readonly ProviderDescriptor[] = [],
): ProviderRegistry => {
  const byKey = new Map<string, ProviderDescriptor>()
  for (const d of listDescriptors()) byKey.set(d.key as string, d)
  for (const d of plugins) {
    const key = d.key as string
    if (!isPluginKey(key)) continue
    if (byKey.has(key)) continue
    byKey.set(key, d)
  }
  const all = [...byKey.values()]
  return {
    get: (key: string): ProviderDescriptor | undefined => byKey.get(key),
    list: (): readonly ProviderDescriptor[] => all,
    catalog: (): readonly ProviderCatalogEntry[] => all.map(toCatalogEntry),
  }
}
