import {
  ModelRouteSchema,
  PluginIdSchema,
  ProviderSchema,
} from "@spectrum/types"
import { z } from "zod"

/** Bump on any breaking config shape change; add a matching `Migration` (see migrations.ts). */
export const CURRENT_CONFIG_VERSION = 13

/**
 * Per-harness "last used" prefs. `mode` is the normalized permission mode the user last selected
 * for this harness, stored as a plain string (like `modelId`) so this package needs no dependency
 * on `@spectrum/agent-events`; the canonical `PermissionMode` is validated at the IPC boundary
 * and re-checked when read at launch. Optional `modelId` overrides the harness default model;
 * optional `thinkingEffort` stores the user's last-selected thinking-effort level.
 */
export const HarnessPrefsSchema = z
  .object({
    mode: z.string().optional(),
    modelId: z.string().optional(),
    thinkingEffort: z.string().optional(),
  })
  .strict()
export type HarnessPrefs = z.infer<typeof HarnessPrefsSchema>

/**
 * Process-wide settings. `proxyHost` is the literal loopback address — the proxy
 * binds `127.0.0.1` only (security.md), so any other host is rejected at validation.
 * Per-harness "last used" model id lives in `lastByHarness` (the modal no longer carries a
 * model selector; the composer model selector reads/writes per-harness prefs directly).
 */
export const SettingsSchema = z
  .object({
    proxyPort: z.number().int().min(1).max(65535).default(4000),
    proxyHost: z.literal("127.0.0.1").default("127.0.0.1"),
    lastSelectedFolder: z.string().default(""),
    lastSelectedHarnessId: z.string().default(""),
    /** Project IDs whose session group the user has collapsed in the sidebar. */
    collapsedProjects: z.array(z.string()).default([]),
    /** Per-harness "last used" prefs, keyed by harness id. Defaults to `{}`. */
    lastByHarness: z.record(z.string(), HarnessPrefsSchema).default({}),
    /** Release channel the in-app updater follows. Default "stable". */
    updateChannel: z.enum(["stable", "canary"]).default("stable"),
    /**
     * The version string of an update the user dismissed from the update
     * notification banner. The banner stays hidden for exactly this version; a newer
     * version re-triggers it. `null` = nothing dismissed.
     */
    dismissedUpdateVersion: z.string().nullable().default(null),
    /**
     * The build `hash` of the update the user dismissed from the banner
     * (unique per build for BOTH stable and canary). The banner stays hidden
     * for exactly this build; a newer build (different hash) re-triggers it.
     * `null` = nothing dismissed by hash. This is the source of truth for
     * dismissal; `dismissedUpdateVersion` is retained only as a legacy
     * fallback for configs written before hash-keyed dismissal existed.
     *
     * Canary CI never bumps package.json `version`, so every canary build
     * reports the same `latestVersion` — keying dismissal on the version would
     * permanently suppress every canary after the first dismiss. The hash is
     * unique per build, so it is the correct dismissal key.
     */
    dismissedUpdateHash: z.string().nullable().default(null),
    /**
     * Max ms to wait for the FIRST streamed chunk from the LLM provider before
     * treating the stream as a silent hang. Generous by default — slow/local models
     * warm up slowly. Buffered providers (e.g. Ollama Cloud) raise this further via
     * their streaming profile. Genuine provider errors surface instantly via the
     * gateway's deterministic error signal regardless of this value.
     */
    firstTokenTimeoutMs: z.number().int().min(5000).max(600000).default(120000),
    /** Max ms of idle gap BETWEEN streamed chunks before treating the stream as hung. */
    interTokenTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
    /**
     * Last-known main window geometry, persisted on resize/move and restored at
     * launch. `null` means "never resized" — the window opens at its default
     * frame. Restored bounds are sanity-checked at the GUI seam (off-screen /
     * too-small bounds fall back to the default), so this stores raw geometry.
     */
    windowBounds: z
      .object({
        width: z.number(),
        height: z.number(),
        x: z.number(),
        y: z.number(),
      })
      .nullable()
      .default(null),
    /**
     * The `ModelId` of a pre-registered model used to generate short, concise
     * session names from the first user prompt. `null` (default) = off: the
     * session name is the truncated first prompt (the existing fallback). When
     * non-null, the referenced `ModelRoute` must still exist in `models[]` at
     * use time; a dangling id (model deleted) is treated as off there — never
     * rewrites the config. Plain `string | null` (not `ModelIdSchema`) so a
     * stray id from a deleted model doesn't fail validation and break the whole
     * config load.
     */
    sessionNameModelId: z.string().nullable().default(null),
  })
  .strict()

export type Settings = z.infer<typeof SettingsSchema>

/** An installed provider plugin and how it got here — spec §6.5. */
export const PluginInstallSchema = z
  .object({
    id: PluginIdSchema,
    source: z.discriminatedUnion("kind", [
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
          /**
           * true  → the plugin is READ LIVE from `path`; editing the working copy takes
           *         effect on the next reload, with no reinstall. The development mode.
           * false → `path` was snapshotted into the plugin root at install time.
           */
          linked: z.boolean(),
        })
        .strict(),
    ]),
    enabled: z.boolean(),
  })
  .strict()

export type PluginInstall = z.infer<typeof PluginInstallSchema>

/** The on-disk config document. `providers`/`models` reuse the locked `@spectrum/types` schemas. */
export const ConfigSchema = z
  .object({
    version: z.number().int(),
    providers: z.array(ProviderSchema),
    models: z.array(ModelRouteSchema),
    settings: SettingsSchema,
    providerPlugins: z.array(PluginInstallSchema).default([]),
  })
  .strict()

export type Config = z.infer<typeof ConfigSchema>

/** Factory defaults for a brand-new install — current version, nothing configured, loopback proxy. */
export const defaultConfig = (): Config => ({
  version: CURRENT_CONFIG_VERSION,
  providers: [],
  models: [],
  settings: SettingsSchema.parse({}),
  providerPlugins: [],
})
