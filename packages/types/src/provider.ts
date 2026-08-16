import { z } from "zod"
import { SdkProviderSchema } from "./enums"
import type { PluginId } from "./ids"
import { ProviderIdSchema, SecretRefSchema } from "./ids"

/** Prefix marking a provider key as supplied by an installed plugin rather than a builtin. */
export const PLUGIN_KEY_PREFIX = "plugin:"

export const PluginProviderKeySchema = z
  .string()
  .regex(/^plugin:[a-z0-9][a-z0-9-]*$/)

/**
 * The identifier selecting a provider's descriptor: either a builtin `SdkProvider` or a
 * `plugin:<id>` key contributed by an installed plugin. Widening `SdkProvider` this way
 * needs no config migration — every config already on disk still parses.
 */
export const ProviderKeySchema = z.union([
  SdkProviderSchema,
  PluginProviderKeySchema,
])
export type ProviderKey = z.infer<typeof ProviderKeySchema>

/** Pure: is this key contributed by a plugin rather than a builtin? */
export const isPluginKey = (key: string): boolean =>
  key.startsWith(PLUGIN_KEY_PREFIX)

/** Pure: the `plugin:<id>` key for a plugin id. */
export const pluginKeyOf = (id: PluginId): string =>
  `${PLUGIN_KEY_PREFIX}${id as string}`

/** Pure: the plugin id inside a plugin key, or undefined for a builtin key. */
export const pluginIdOf = (key: string): string | undefined =>
  isPluginKey(key) ? key.slice(PLUGIN_KEY_PREFIX.length) : undefined

export const ProviderSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().min(1),
    sdkProvider: ProviderKeySchema,
    config: z.record(z.string(), z.string()),
    secrets: z.record(z.string(), SecretRefSchema),
    models: z.array(z.string()),
  })
  .strict()

export type Provider = z.infer<typeof ProviderSchema>
