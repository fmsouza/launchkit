import { z } from "zod"

/**
 * Where an installed extension's files come from. Mirrors `PluginInstallSchema`'s `source`
 * discriminated union (`@spectrum/config`, `packages/config/src/schema.ts:110`) — duplicated
 * here rather than imported because `packages/ipc` does not depend on `@spectrum/config`.
 * Keep the two shapes in sync by hand.
 */
export const ExtensionSourceSchema = z.discriminatedUnion("kind", [
  /** Hand-placed directory under the plugin root; Spectrum did not install it. */
  z
    .object({ kind: z.literal("local") })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.string(),
      ref: z.string(),
      commit: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      path: z.string(),
      /** true → read live from `path` (the `link` install mode); false → a snapshotted copy. */
      linked: z.boolean(),
    })
    .strict(),
])
export type ExtensionSource = z.infer<typeof ExtensionSourceSchema>

/**
 * Lifecycle status of a plugin-contributed provider's supervised child process. The same four
 * values as `PluginStatus` (`@spectrum/provider-host`, `packages/provider-host/src/host.ts:21`)
 * — not imported here so `packages/ipc` stays free of a `@spectrum/provider-host` dependency.
 */
export const ContributedProviderStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "failed",
])
export type ContributedProviderStatus = z.infer<
  typeof ContributedProviderStatusSchema
>

/**
 * One provider an installed extension contributes, as disclosed to the GUI.
 *
 * `launchCommand`/`launchArgs`/`secretFieldNames` cross the boundary ON PURPOSE (spec §3):
 * Spectrum's obligation is to show what will be spawned and which secrets it will receive.
 * But `launchArgs` is the UNRENDERED template straight from the manifest — a rendered arg
 * list can carry a resolved secret (a manifest may declare `--api-key {{apiKey}}`) — and
 * there is no `env` field at all: an env map, rendered or not, never crosses this boundary.
 * `.strict()` is what makes "rejects a resolved env map" a real guard rather than a formality.
 */
export const ContributedProviderViewSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    status: ContributedProviderStatusSchema,
    launchCommand: z.string().min(1).optional(),
    launchArgs: z.array(z.string()).optional(),
    secretFieldNames: z.array(z.string()),
  })
  .strict()
export type ContributedProviderView = z.infer<
  typeof ContributedProviderViewSchema
>

/**
 * One installed (or hand-placed) extension, as disclosed to the GUI. Never carries a secret
 * value, a resolved env map, a host token, or an instance key — those are the exact things
 * `.strict()` throughout this schema and `ContributedProviderViewSchema` exist to refuse.
 */
export const ExtensionViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean(),
    source: ExtensionSourceSchema,
    /**
     * True when a linked source's directory has vanished: `registry.list()` skips it rather
     * than failing the whole batch, so this row is reconstructed from the install record
     * alone, with no contributed providers.
     */
    unavailable: z.boolean(),
    ignoredContributions: z.array(z.string()),
    providers: z.array(ContributedProviderViewSchema),
  })
  .strict()
export type ExtensionView = z.infer<typeof ExtensionViewSchema>
