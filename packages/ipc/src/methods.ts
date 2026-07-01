import {
  AttachmentKindSchema,
  AttachmentRefSchema,
  PermissionModeSchema,
  StoredEventSchema,
  ThinkingEffortSchema,
} from "@spectrum/agent-events"
import { ProviderCatalogEntrySchema } from "@spectrum/providers"
import {
  HarnessDefinitionSchema,
  HarnessIdSchema,
  ModelIdSchema,
  ModelRouteSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SdkProviderSchema,
  SessionIdSchema,
  SessionSchema,
} from "@spectrum/types"
import { z } from "zod"
import { ProviderViewSchema } from "./provider-view"

/** `void` over the wire is encoded as `null` (JSON has no `undefined`). */
const VoidSchema = z.null()

// ── Providers ────────────────────────────────────────────────────────────────

export const GetProvidersParamsSchema = z.undefined()
export const GetProvidersResultSchema = z.array(ProviderViewSchema)

export const GetProviderCatalogParamsSchema = z.undefined()
export const GetProviderCatalogResultSchema = z.array(
  ProviderCatalogEntrySchema,
)

/**
 * BASE mutation shape: non-secret config + secret field *names* only.
 * Used by `updateProvider`, which must never receive secret values.
 * `AddProviderParamsSchema` extends this with an optional inline `secrets`
 * record for an atomic create-with-secrets flow.
 */
const ProviderMutationInputSchema = z
  .object({
    name: z.string().optional(),
    sdkProvider: SdkProviderSchema,
    config: z.record(z.string(), z.string()),
    secretFieldNames: z.array(z.string()),
    models: z.array(z.string()),
  })
  .strict()

/** Add carries optional inline secret VALUES (inbound-only) for an atomic create. */
export const AddProviderParamsSchema = ProviderMutationInputSchema.extend({
  secrets: z.record(z.string(), z.string()).optional(),
}).strict()
export const AddProviderResultSchema = ProviderViewSchema

export const UpdateProviderParamsSchema = z
  .object({
    id: ProviderIdSchema,
    input: ProviderMutationInputSchema,
  })
  .strict()
export const UpdateProviderResultSchema = ProviderViewSchema

export const DeleteProviderParamsSchema = z
  .object({ id: ProviderIdSchema })
  .strict()
export const DeleteProviderResultSchema = VoidSchema

export const TestProviderParamsSchema = z
  .object({ id: ProviderIdSchema })
  .strict()
export const TestProviderResultSchema = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().nonnegative(),
  })
  .strict()

/**
 * The ONLY method whose params carry a raw secret value, and it is inbound
 * (webview→main) only — there is no corresponding main→webview result that
 * echoes it back (returns void).
 */
export const SetProviderSecretParamsSchema = z
  .object({
    providerId: ProviderIdSchema,
    field: z.string().min(1),
    value: z.string().min(1),
  })
  .strict()
export const SetProviderSecretResultSchema = VoidSchema

// ── Models ───────────────────────────────────────────────────────────────────

export const GetModelsParamsSchema = z.undefined()
export const GetModelsResultSchema = z.array(ModelRouteSchema)

/** Add accepts provider + model only; the server mints the opaque id. */
export const AddModelParamsSchema = z
  .object({
    providerId: ProviderIdSchema,
    providerModel: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  })
  .strict()
export const AddModelResultSchema = ModelRouteSchema

/** Update keys by id and carries the new provider + model. */
export const UpdateModelParamsSchema = z
  .object({
    id: ModelIdSchema,
    input: ModelRouteSchema.omit({ id: true }),
  })
  .strict()
export const UpdateModelResultSchema = ModelRouteSchema

export const DeleteModelParamsSchema = z.object({ id: ModelIdSchema }).strict()
export const DeleteModelResultSchema = VoidSchema

// ── Harnesses ─────────────────────────────────────────────────────────────────

export const GetHarnessesParamsSchema = z.undefined()

/**
 * Harness-VIEW shape: each builtin harness definition plus a data-driven `native` flag derived from
 * the backend driver registry (`driverRegistry.isNative`). Every launchable harness is native and
 * renders the native RunView — single source of truth = the registry.
 */
export const HarnessViewSchema = HarnessDefinitionSchema.extend({
  native: z.boolean(),
})
export type HarnessView = z.infer<typeof HarnessViewSchema>
export const GetHarnessesResultSchema = z.array(HarnessViewSchema)

export const LaunchHarnessParamsSchema = z
  .object({
    id: HarnessIdSchema,
    modelId: ModelIdSchema.optional(),
    name: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()
/**
 * Launching opens a native run session via the RunManager (which creates the Session internally),
 * so the GUI only needs the new session's id back — not the full Session.
 */
export const LaunchHarnessResultSchema = z
  .object({ sessionId: SessionIdSchema })
  .strict()

// ── Sessions & proxy ──────────────────────────────────────────────────────────

export const GetSessionsParamsSchema = z
  .object({
    harnessId: HarnessIdSchema.optional(),
    modelId: ModelIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    running: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional()
export const GetSessionsResultSchema = z.array(SessionSchema)

export const GetProxyStatusParamsSchema = z.undefined()
export const GetProxyStatusResultSchema = z
  .object({
    running: z.boolean(),
    port: z.number().int().nonnegative(),
  })
  .strict()

// The webview asks for the dedicated runner WebSocket URL (a loopback ws the bun side serves for the
// canonical run-event stream — see apps/desktop/src/gui/runner-socket.ts) and connects to it directly.
export const GetRunnerSocketUrlParamsSchema = z.undefined()
export const GetRunnerSocketUrlResultSchema = z
  .object({ url: z.string() })
  .strict()

// Replay: the full ordered canonical event log for a session, validated by StoredEventSchema.
export const GetRunEventsParamsSchema = z
  .object({ id: SessionIdSchema })
  .strict()
export const GetRunEventsResultSchema = z
  .object({ events: z.array(StoredEventSchema) })
  .strict()

// ── Terminal (in-app terminal panel) ──────────────────────────────────────

/**
 * The webview asks for the dedicated terminal WebSocket URL (a loopback ws the
 * bun side serves for the internal terminal panel — see
 * apps/desktop/src/gui/terminal-socket.ts). Distinct from `getRunnerSocketUrl`,
 * which carries canonical run events for the harness driver; the terminal
 * socket carries raw PTY bytes for the in-app terminal tab.
 */
export const GetTerminalSocketUrlParamsSchema = z.undefined()
export const GetTerminalSocketUrlResultSchema = z
  .object({ url: z.string().min(1) })
  .strict()

// ── Update push socket ──────────────────────────────────────────────────────
/**
 * The webview asks for the dedicated update WebSocket URL (a loopback ws the bun
 * side serves for pushed UpdateState frames — see apps/desktop/src/gui/update-socket.ts).
 * Push-only: the bun side re-checks the release feed on a timer and pushes the fresh
 * UpdateState so the banner appears the moment a new build is detected while the app
 * is open. Distinct from the request/response `getUpdateState`/`checkForUpdate`.
 */
export const GetUpdateSocketUrlParamsSchema = z.undefined()
export const GetUpdateSocketUrlResultSchema = z
  .object({ url: z.string().min(1) })
  .strict()

/**
 * Resolve the effective working directory the terminal panel should spawn the
 * shell in. The bun side runs the resolver (where the DB row + project path
 * are available); the webview never sees `projectId` — the public `Session`
 * type drops it.
 */
export const ResolveTerminalCwdParamsSchema = z
  .object({ sessionId: SessionIdSchema })
  .strict()
export const ResolveTerminalCwdResultSchema = z
  .object({ cwd: z.string().min(1) })
  .strict()

// Delete a single session and all its run events (cascade lives in @spectrum/data-admin).
export const DeleteSessionParamsSchema = z
  .object({ sessionId: SessionIdSchema })
  .strict()
export const DeleteSessionResultSchema = VoidSchema

// Rename a session in place (manual user rename). The handler trims + rejects blank before
// calling SessionStore.updateName; the schema's min(1) is a defense-in-depth backstop.
export const RenameSessionParamsSchema = z
  .object({ sessionId: SessionIdSchema, name: z.string().min(1) })
  .strict()
export const RenameSessionResultSchema = VoidSchema

// ── Model discovery ───────────────────────────────────────────────────────

export const ListProviderModelsParamsSchema = z
  .object({ providerId: ProviderIdSchema })
  .strict()
export const ListProviderModelsResultSchema = z
  .object({ models: z.array(z.string()) })
  .strict()

/**
 * Draft (un-saved) probes carry raw secret VALUES inbound-only (like setProviderSecret).
 * Their RESULTS never echo secrets — only {ok,latencyMs} / {models}.
 */
const DraftProbeInputSchema = z
  .object({
    sdkProvider: SdkProviderSchema,
    config: z.record(z.string(), z.string()),
    secrets: z.record(z.string(), z.string()),
  })
  .strict()

export const TestProviderDraftParamsSchema = DraftProbeInputSchema.extend({
  providerModel: z.string(),
}).strict()
export const TestProviderDraftResultSchema = TestProviderResultSchema

export const ListProviderModelsDraftParamsSchema = DraftProbeInputSchema
export const ListProviderModelsDraftResultSchema =
  ListProviderModelsResultSchema

// ── Dialogs ────────────────────────────────────────────────────────────────

// Native folder picker. Params (and the starting hint) are optional; a cancelled
// dialog resolves to `{}` (no `path`), never an error.
export const PickFolderParamsSchema = z
  .object({ startingFolder: z.string().optional() })
  .strict()
  .optional()
export const PickFolderResultSchema = z
  .object({ path: z.string().optional() })
  .strict()

// ── External links ──────────────────────────────────────────────────────────

/**
 * Open a URL in the OS default browser. Inbound-only (webview→main); returns
 * void. Any non-empty string is accepted (the bun side delegates straight to
 * Electrobun `Utils.openExternal`, which the OS routes to the registered
 * handler for the scheme — http/https → browser, mailto: → mail client, etc.).
 */
export const OpenExternalUrlParamsSchema = z
  .object({
    /** The URL to open in the OS default browser; min(1) rejects empty strings. */
    url: z.string().min(1),
  })
  .strict()
export const OpenExternalUrlResultSchema = VoidSchema

// ── Media uploads (file picker → uploads dir → data URL / external open) ────

/**
 * Open the native multi-file picker, copy each accepted file into the
 * `uploads/` dir, and return the resulting `AttachmentRef`s. Files whose
 * inferred `kind` is not in `acceptedKinds` are returned in `rejected`
 * (the caller decides whether to surface a toast or simply drop them).
 */
export const PickUploadsParamsSchema = z
  .object({
    /** MIME allowlist forwarded to the native picker (image/*, application/pdf, etc.). */
    acceptedMimes: z.array(z.string()),
    /** Kinds the caller is willing to consume (image/pdf/text/binary). */
    acceptedKinds: z.array(AttachmentKindSchema),
  })
  .strict()
export const PickUploadsResultSchema = z
  .object({
    uploads: z.array(AttachmentRefSchema),
    rejected: z
      .array(
        z
          .object({
            displayName: z.string(),
            reason: z.literal("unsupported-kind"),
          })
          .strict(),
      )
      .optional(),
    /**
     * Per-file IO failures the picker couldn't save (the file was unreadable,
     * too large, etc.). The caller surfaces each as a toast so the user knows
     * the file wasn't attached — silently dropping it would be confusing.
     */
    errors: z
      .array(
        z
          .object({
            displayName: z.string(),
            reason: z.enum(["io-failed", "too-large"]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/**
 * Build a `data:<mime>;base64,...` URL for a stored upload's thumbnail bytes
 * (full image data — the renderer is responsible for sizing). The `mime` is
 * required: it comes from the `AttachmentRef` the caller already has, and
 * the handler never re-infers it from the on-disk file extension. `missing`
 * means the file no longer exists on disk (was cleaned up between pick and
 * render).
 */
export const ReadUploadThumbnailParamsSchema = z
  .object({
    id: z.string().min(1),
    mime: z.string().min(1),
  })
  .strict()
export const ReadUploadThumbnailResultSchema = z
  .object({
    dataUrl: z.string().optional(),
    missing: z.literal(true).optional(),
  })
  .strict()

/**
 * Build a `data:<mime>;base64,...` URL for a stored upload's FULL bytes
 * (used by the send path + the lightbox). Same shape as the thumbnail
 * result; the caller distinguishes by intent.
 */
export const ReadUploadDataUrlParamsSchema = z
  .object({
    id: z.string().min(1),
    mime: z.string().min(1),
  })
  .strict()
export const ReadUploadDataUrlResultSchema = ReadUploadThumbnailResultSchema

/**
 * Open an upload's on-disk file in the OS default viewer (Preview for PDFs,
 * etc.). The handler reconstructs the path from `id` via `UploadStore.pathOf`
 * — the webview never sends a path. Success returns `null` (the caller's
 * intent is "open it" — no payload to echo). A failure surfaces as either:
 *   - `missing:true` — the id is unknown / the file is gone
 *   - `opened:false` — the path was resolved but lives OUTSIDE the uploads
 *     dir (security check rejected it)
 * The actual `Utils.openExternal` failure (OS refused) raises a handler error
 * the ipc server wraps as `handler-failed` (matches the `openExternalUrl`
 * handler's contract).
 */
export const OpenUploadExternalParamsSchema = z
  .object({ id: z.string().min(1) })
  .strict()
export const OpenUploadExternalResultSchema = z
  .union([
    VoidSchema,
    z.object({ opened: z.literal(false) }).strict(),
    z.object({ missing: z.literal(true) }).strict(),
  ])
  .nullable()

// ── Settings ──────────────────────────────────────────────────────────────

// Read the persisted, non-secret settings the GUI needs to prefill its UI: the
// last launched cwd and harness. The New Session modal seeds its fields from these.
// Per-harness prefs (mode + model) live in `lastByHarness` and are read directly by
// the composer; they are NOT shipped over this endpoint. Empty strings mean "nothing
// remembered yet".
export const GetSettingsParamsSchema = z.undefined()
export const GetSettingsResultSchema = z
  .object({
    lastSelectedFolder: z.string(),
    lastSelectedHarnessId: z.string(),
    collapsedProjects: z.array(z.string()),
  })
  .strict()

// Persist a per-harness "last used" pref. Inbound (webview→main) only; returns void. The mode is
// validated against the canonical PermissionMode here so config never stores an unrecognized value.
// `modelId` is a plain string (not ModelIdSchema) so it accepts "" to mean "default/clear".
export const UpdateHarnessPrefsParamsSchema = z
  .object({
    harnessId: HarnessIdSchema,
    mode: PermissionModeSchema.optional(),
    modelId: z.string().optional(),
    thinkingEffort: ThinkingEffortSchema.optional(),
  })
  .strict()
export const UpdateHarnessPrefsResultSchema = VoidSchema

// ── Timeout settings ──────────────────────────────────────────────────────

// Read both LLM streaming timeout values from persisted settings.
export const GetTimeoutSettingsParamsSchema = z.undefined()
export const GetTimeoutSettingsResultSchema = z
  .object({
    // mirrors SettingsSchema (packages/config/src/schema.ts)
    firstTokenTimeoutMs: z.number().int(),
    interTokenTimeoutMs: z.number().int(),
  })
  .strict()

// Persist both LLM streaming timeout values. Bounds mirror SettingsSchema.
export const UpdateTimeoutSettingsParamsSchema = z
  .object({
    // mirrors SettingsSchema: min 5000 max 600000
    firstTokenTimeoutMs: z.number().int().min(5000).max(600000),
    // mirrors SettingsSchema: min 1000 max 600000
    interTokenTimeoutMs: z.number().int().min(1000).max(600000),
  })
  .strict()
export const UpdateTimeoutSettingsResultSchema = VoidSchema

// ── Session naming ─────────────────────────────────────────────────────────

// Read the AI session-naming model id (null = off). Mirrors SettingsSchema.
export const GetSessionNamingSettingsParamsSchema = z.undefined()
export const GetSessionNamingSettingsResultSchema = z
  .object({ sessionNameModelId: z.string().nullable() })
  .strict()

// Persist the AI session-naming model id (null = off; string = a ModelId). Mirrors SettingsSchema.
export const UpdateSessionNamingSettingsParamsSchema = z
  .object({ sessionNameModelId: z.string().nullable() })
  .strict()
export const UpdateSessionNamingSettingsResultSchema = VoidSchema

// ── Projects ──────────────────────────────────────────────────────────────

export const GetProjectsParamsSchema = z.undefined()
/** Alphabetical (case-insensitive) by name; each carries its total session count. */
export const GetProjectsResultSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      sessionCount: z.number().int().nonnegative(),
    })
    .strict(),
)

export const SetCollapsedProjectsParamsSchema = z
  .object({ ids: z.array(z.string()) })
  .strict()
export const SetCollapsedProjectsResultSchema = VoidSchema

// Delete a project and all its sessions + their run events (cascade in @spectrum/data-admin).
export const DeleteProjectParamsSchema = z
  .object({ projectId: ProjectIdSchema })
  .strict()
export const DeleteProjectResultSchema = VoidSchema

// ── Data (factory reset) ────────────────────────────────────────────────────

// Wipe ALL app data (db + config + keychain secrets + runtime) and relaunch to a
// first-launch state. Inbound-only; the handler may relaunch before it returns.
export const ResetAppParamsSchema = z.undefined()
export const ResetAppResultSchema = VoidSchema

// ── Updates ─────────────────────────────────────────────────────────────────

export const ChannelSchema = z.enum(["stable", "canary"])

export const UpdatePhaseSchema = z.enum([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "applying",
  "error",
])

/** Full updater state crossing to the webview. `void` mutations return null. */
export const UpdateStateSchema = z
  .object({
    phase: UpdatePhaseSchema,
    currentVersion: z.string(),
    latestVersion: z.string().nullable(),
    /**
     * The build `hash` of the latest available build (unique per build for BOTH
     * stable and canary), or null when up-to-date / unknown. Unlike
     * `latestVersion` — which canary CI never bumps (frozen at the last stable
     * `package.json` version) — the hash changes on every build, so it is the
     * correct key for per-build update dismissal.
     */
    latestHash: z.string().nullable(),
    available: z.boolean(),
    progress: z.number().min(0).max(1),
    error: z.string().nullable(),
    channel: ChannelSchema,
    showBanner: z.boolean(),
  })
  .strict()
export type UpdateState = z.infer<typeof UpdateStateSchema>

export const GetUpdateStateParamsSchema = z.undefined()
export const GetUpdateStateResultSchema = UpdateStateSchema

export const CheckForUpdateParamsSchema = z.undefined()
export const CheckForUpdateResultSchema = UpdateStateSchema

export const StartUpdateDownloadParamsSchema = z.undefined()
export const StartUpdateDownloadResultSchema = VoidSchema

export const ApplyUpdateParamsSchema = z.undefined()
export const ApplyUpdateResultSchema = VoidSchema

export const DismissUpdateParamsSchema = z
  // Key dismissal on the build `hash` (unique per build for both channels),
  // not the version string — canary CI never bumps package.json version, so a
  // version-keyed dismissal permanently suppresses every canary after the
  // first dismiss. See policy.ts.
  .object({ hash: z.string().min(1) })
  .strict()
export const DismissUpdateResultSchema = VoidSchema

export const SetUpdateChannelParamsSchema = z
  .object({ channel: ChannelSchema })
  .strict()
export const SetUpdateChannelResultSchema = UpdateStateSchema

// ── Client logging (webview → main) ─────────────────────────────────────────
// The webview forwards error/fatal records here so they persist to the main log file.
// Inbound-only; redacted main-side. `level` is restricted to the two forwarded severities.
export const LogClientErrorParamsSchema = z
  .object({
    scope: z.string().min(1),
    level: z.enum(["error", "fatal"]),
    msg: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export const LogClientErrorResultSchema = VoidSchema

// ── The method → {params, result} schema map ──────────────────────────────────

/** Maps each contract method to its on-the-wire param + result zod schemas. */
export const IpcMethodSchemas = {
  getProviders: {
    params: GetProvidersParamsSchema,
    result: GetProvidersResultSchema,
  },
  getProviderCatalog: {
    params: GetProviderCatalogParamsSchema,
    result: GetProviderCatalogResultSchema,
  },
  addProvider: {
    params: AddProviderParamsSchema,
    result: AddProviderResultSchema,
  },
  updateProvider: {
    params: UpdateProviderParamsSchema,
    result: UpdateProviderResultSchema,
  },
  deleteProvider: {
    params: DeleteProviderParamsSchema,
    result: DeleteProviderResultSchema,
  },
  testProvider: {
    params: TestProviderParamsSchema,
    result: TestProviderResultSchema,
  },
  setProviderSecret: {
    params: SetProviderSecretParamsSchema,
    result: SetProviderSecretResultSchema,
  },
  getModels: {
    params: GetModelsParamsSchema,
    result: GetModelsResultSchema,
  },
  addModel: { params: AddModelParamsSchema, result: AddModelResultSchema },
  updateModel: {
    params: UpdateModelParamsSchema,
    result: UpdateModelResultSchema,
  },
  deleteModel: {
    params: DeleteModelParamsSchema,
    result: DeleteModelResultSchema,
  },
  getHarnesses: {
    params: GetHarnessesParamsSchema,
    result: GetHarnessesResultSchema,
  },
  launchHarness: {
    params: LaunchHarnessParamsSchema,
    result: LaunchHarnessResultSchema,
  },
  getSessions: {
    params: GetSessionsParamsSchema,
    result: GetSessionsResultSchema,
  },
  deleteSession: {
    params: DeleteSessionParamsSchema,
    result: DeleteSessionResultSchema,
  },
  renameSession: {
    params: RenameSessionParamsSchema,
    result: RenameSessionResultSchema,
  },
  getProxyStatus: {
    params: GetProxyStatusParamsSchema,
    result: GetProxyStatusResultSchema,
  },
  getRunnerSocketUrl: {
    params: GetRunnerSocketUrlParamsSchema,
    result: GetRunnerSocketUrlResultSchema,
  },
  getTerminalSocketUrl: {
    params: GetTerminalSocketUrlParamsSchema,
    result: GetTerminalSocketUrlResultSchema,
  },
  getUpdateSocketUrl: {
    params: GetUpdateSocketUrlParamsSchema,
    result: GetUpdateSocketUrlResultSchema,
  },
  resolveTerminalCwd: {
    params: ResolveTerminalCwdParamsSchema,
    result: ResolveTerminalCwdResultSchema,
  },
  getRunEvents: {
    params: GetRunEventsParamsSchema,
    result: GetRunEventsResultSchema,
  },
  pickFolder: {
    params: PickFolderParamsSchema,
    result: PickFolderResultSchema,
  },
  openExternalUrl: {
    params: OpenExternalUrlParamsSchema,
    result: OpenExternalUrlResultSchema,
  },
  pickUploads: {
    params: PickUploadsParamsSchema,
    result: PickUploadsResultSchema,
  },
  readUploadThumbnail: {
    params: ReadUploadThumbnailParamsSchema,
    result: ReadUploadThumbnailResultSchema,
  },
  readUploadDataUrl: {
    params: ReadUploadDataUrlParamsSchema,
    result: ReadUploadDataUrlResultSchema,
  },
  openUploadExternal: {
    params: OpenUploadExternalParamsSchema,
    result: OpenUploadExternalResultSchema,
  },
  listProviderModels: {
    params: ListProviderModelsParamsSchema,
    result: ListProviderModelsResultSchema,
  },
  testProviderDraft: {
    params: TestProviderDraftParamsSchema,
    result: TestProviderDraftResultSchema,
  },
  listProviderModelsDraft: {
    params: ListProviderModelsDraftParamsSchema,
    result: ListProviderModelsDraftResultSchema,
  },
  getSettings: {
    params: GetSettingsParamsSchema,
    result: GetSettingsResultSchema,
  },
  getTimeoutSettings: {
    params: GetTimeoutSettingsParamsSchema,
    result: GetTimeoutSettingsResultSchema,
  },
  updateTimeoutSettings: {
    params: UpdateTimeoutSettingsParamsSchema,
    result: UpdateTimeoutSettingsResultSchema,
  },
  getSessionNamingSettings: {
    params: GetSessionNamingSettingsParamsSchema,
    result: GetSessionNamingSettingsResultSchema,
  },
  updateSessionNamingSettings: {
    params: UpdateSessionNamingSettingsParamsSchema,
    result: UpdateSessionNamingSettingsResultSchema,
  },
  getProjects: {
    params: GetProjectsParamsSchema,
    result: GetProjectsResultSchema,
  },
  setCollapsedProjects: {
    params: SetCollapsedProjectsParamsSchema,
    result: SetCollapsedProjectsResultSchema,
  },
  deleteProject: {
    params: DeleteProjectParamsSchema,
    result: DeleteProjectResultSchema,
  },
  resetApp: {
    params: ResetAppParamsSchema,
    result: ResetAppResultSchema,
  },
  updateHarnessPrefs: {
    params: UpdateHarnessPrefsParamsSchema,
    result: UpdateHarnessPrefsResultSchema,
  },
  getUpdateState: {
    params: GetUpdateStateParamsSchema,
    result: GetUpdateStateResultSchema,
  },
  checkForUpdate: {
    params: CheckForUpdateParamsSchema,
    result: CheckForUpdateResultSchema,
  },
  startUpdateDownload: {
    params: StartUpdateDownloadParamsSchema,
    result: StartUpdateDownloadResultSchema,
  },
  applyUpdate: {
    params: ApplyUpdateParamsSchema,
    result: ApplyUpdateResultSchema,
  },
  dismissUpdate: {
    params: DismissUpdateParamsSchema,
    result: DismissUpdateResultSchema,
  },
  setUpdateChannel: {
    params: SetUpdateChannelParamsSchema,
    result: SetUpdateChannelResultSchema,
  },
  logClientError: {
    params: LogClientErrorParamsSchema,
    result: LogClientErrorResultSchema,
  },
} as const

/** The set of valid method names, derived from the schema map. */
export type IpcMethodName = keyof typeof IpcMethodSchemas

/**
 * The typed contract: method name → its params + result TypeScript types,
 * inferred from the schemas above (single source of truth).
 */
export type IpcMethods = {
  readonly [K in IpcMethodName]: {
    readonly params: z.infer<(typeof IpcMethodSchemas)[K]["params"]>
    readonly result: z.infer<(typeof IpcMethodSchemas)[K]["result"]>
  }
}
