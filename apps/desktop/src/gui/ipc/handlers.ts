import { stat } from "node:fs/promises"
import path from "node:path"

import {
  type AttachmentKind,
  type AttachmentRef,
  PermissionModeSchema,
  ThinkingEffortSchema,
  inferKind,
} from "@spectrum/agent-events"
import type { IpcHandlers, ProviderView } from "@spectrum/ipc"
import { providerCatalog, validateProviderConfig } from "@spectrum/providers"
import type { ModelId, ModelRoute, Provider, SecretRef } from "@spectrum/types"
import { isOk } from "@spectrum/utils"
import type { GuiContext } from "../../composition"
import { buildUpdateState as buildUpdateStateShared } from "../updater/build-update-state"
import type { Channel } from "../updater/updater-adapter"
import { resolveTerminalCwd } from "./terminal-cwd"

/**
 * Project a `Provider` to the secret-free `ProviderView` that crosses IPC to the webview.
 * SECURITY (security.md): `secrets` (keychain refs) is replaced by presence flags only — no `ref`,
 * no value ever leaves the main process. This is the single mapping the masking tests pin.
 */
const toProviderView = (provider: Provider): ProviderView => ({
  id: provider.id,
  name: provider.name,
  sdkProvider: provider.sdkProvider,
  config: provider.config,
  secretFields: Object.fromEntries(
    Object.keys(provider.secrets).map(
      (field) => [field, { isSet: true }] as const,
    ),
  ),
  models: provider.models,
})

/**
 * Async existence check for a filesystem path (true if stat() resolves, false on any error).
 * Lives at module scope so the terminal cwd handler can reuse it without re-implementing.
 */
const fsExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Tiny extension → MIME table for the file-picker path. The native picker's
 * `acceptedMimes` does the heavy lifting (the OS restricts the dialog to
 * matching files), but the resulting path may carry a name whose extension
 * the OS didn't classify. Defaults to `application/octet-stream` so the
 * resulting `AttachmentRef.mime` is always a non-empty, valid string the
 * renderer can round-trip.
 */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
}
const mimeFromExt = (displayName: string): string => {
  const dot = displayName.lastIndexOf(".")
  if (dot === -1 || dot === displayName.length - 1) {
    return "application/octet-stream"
  }
  const ext = displayName.slice(dot + 1).toLowerCase()
  return EXTENSION_MIME[ext] ?? "application/octet-stream"
}

/** Format a base64 string as a `data:<mime>;base64,...` URL. */
const toDataUrl = (mime: string, base64: string): string =>
  `data:${mime};base64,${base64}`

/**
 * Bind the `@spectrum/ipc` contract to the wired subsystems. Each handler is `async` and either
 * returns the validated result shape or throws (the ipc server turns a throw into a `handler-failed`
 * IpcError; nothing leaks a stack trace because the server stringifies `error.message` only).
 * `void` results are encoded as `null` (the ipc VoidSchema), matching `04-ipc.md`.
 */
export const createIpcHandlers = (ctx: GuiContext): IpcHandlers => {
  // Raised inside a handler so the ipc server wraps it as a typed handler-failed IpcError.
  // Logged once centrally so every handler failure leaves a persisted trace (message only —
  // handlers never put secrets in fail() messages).
  const fail = (message: string): never => {
    ctx.log.child("ipc").error(message)
    throw new Error(message)
  }

  /** Best-effort human detail for an erased ProxyError (no secrets ever appear in these). */
  const describeError = (e: unknown): string => {
    if (typeof e === "object" && e !== null) {
      const o = e as { kind?: unknown; detail?: unknown; sdkProvider?: unknown }
      if (typeof o.detail === "string" && o.detail !== "") return o.detail
      if (
        o.kind === "unsupported-model-discovery" &&
        typeof o.sdkProvider === "string"
      )
        return `model discovery is not supported for "${o.sdkProvider}"`
      if (typeof o.kind === "string") return o.kind
    }
    if (e instanceof Error && e.message !== "") return e.message
    return "unknown error"
  }

  /** Load config or throw a message-safe handler error. */
  const loadConfig = async () => {
    const loaded = await ctx.config.load()
    if (!isOk(loaded)) return fail("could not load config")
    return loaded.value
  }

  /**
   * Thin wrapper: delegates to the shared `buildUpdateState` helper (extracted
   * to `../updater/build-update-state.ts`) so there is one source of truth for
   * how `UpdateState` is assembled from the raw adapter snapshot + config.
   */
  const buildUpdateState = async (): Promise<
    import("@spectrum/ipc").IpcMethods["getUpdateState"]["result"]
  > => buildUpdateStateShared({ updater: ctx.updater, config: ctx.config })

  return {
    // ── Providers ──────────────────────────────────────────────────────────────────────
    getProviders: async () => {
      const config = await loadConfig()
      return config.providers.map(toProviderView)
    },

    getProviderCatalog: async () => [...providerCatalog()],

    addProvider: async (input) => {
      const config = await loadConfig()
      const valid = validateProviderConfig(input.sdkProvider, input.config)
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      // A blank/missing name falls back to the SDK provider name so a persisted provider always
      // has a RESOLVED non-empty name (ProviderSchema.name stays min(1)). The fallback lives here
      // so the rule is consistent for every IPC client.
      const name =
        input.name !== undefined && input.name.trim() !== ""
          ? input.name.trim()
          : input.sdkProvider
      // Atomic create: write each inline secret VALUE to the keychain, keep only the ref.
      const secrets: Record<string, SecretRef> = {}
      for (const [field, value] of Object.entries(input.secrets ?? {})) {
        // Defense-in-depth: only persist secrets for fields the provider actually declares.
        if (!input.secretFieldNames.includes(field)) continue
        if (value === "") continue
        const set = await ctx.secrets.set(value)
        if (!isOk(set)) return fail("could not store secret")
        secrets[field] = set.value
      }
      const provider: Provider = {
        id: `p_${crypto.randomUUID()}` as Provider["id"],
        name,
        sdkProvider: input.sdkProvider,
        config: input.config,
        secrets,
        models: input.models,
      }
      const saved = await ctx.config.save({
        ...config,
        providers: [...config.providers, provider],
      })
      if (!isOk(saved)) return fail("could not save provider")
      return toProviderView(provider)
    },

    updateProvider: async ({ id, input }) => {
      const config = await loadConfig()
      const existing = config.providers.find((p) => p.id === id)
      if (existing === undefined) return fail(`unknown provider: ${String(id)}`)
      const valid = validateProviderConfig(input.sdkProvider, input.config)
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      // Same fallback as addProvider: a blank/missing name resolves to the SDK provider name.
      const name =
        input.name !== undefined && input.name.trim() !== ""
          ? input.name.trim()
          : input.sdkProvider
      // Preserve existing secret refs; only non-secret fields are updatable over IPC.
      const updated: Provider = {
        ...existing,
        name,
        sdkProvider: input.sdkProvider,
        config: input.config,
        models: input.models,
      }
      const providers = config.providers.map((p) => (p.id === id ? updated : p))
      const saved = await ctx.config.save({ ...config, providers })
      if (!isOk(saved)) return fail("could not save provider")
      return toProviderView(updated)
    },

    deleteProvider: async ({ id }) => {
      const config = await loadConfig()
      const providers = config.providers.filter((p) => p.id !== id)
      const saved = await ctx.config.save({ ...config, providers })
      if (!isOk(saved)) return fail("could not delete provider")
      return null
    },

    testProvider: async ({ id }) => {
      // Delegates to the tester wired by the tray-and-polish plan (see AppContext.testProvider).
      const result = await ctx.testProvider(String(id))
      if (!isOk(result)) return fail("provider test failed")
      return result.value
    },

    setProviderSecret: async ({ providerId, field, value }) => {
      const config = await loadConfig()
      const existing = config.providers.find((p) => p.id === providerId)
      if (existing === undefined)
        return fail(`unknown provider: ${String(providerId)}`)

      // The ONLY inbound secret path: write the raw value straight to the keychain ...
      const set = await ctx.secrets.set(value)
      if (!isOk(set)) return fail("could not store secret")
      const ref: SecretRef = set.value

      // ... then persist ONLY the returned ref on the provider (never the value).
      const updated: Provider = {
        ...existing,
        secrets: { ...existing.secrets, [field]: ref },
      }
      const providers = config.providers.map((p) =>
        p.id === providerId ? updated : p,
      )
      const saved = await ctx.config.save({ ...config, providers })
      if (!isOk(saved)) return fail("could not save secret reference")
      return null
    },

    // ── Models ───────────────────────────────────────────────────────────────────────
    getModels: async () => {
      const config = await loadConfig()
      return config.models
    },

    addModel: async (input) => {
      const config = await loadConfig()
      const model: ModelRoute = {
        id: `mdl_${crypto.randomUUID()}` as ModelRoute["id"],
        providerId: input.providerId,
        providerModel: input.providerModel,
        aliases: input.aliases,
      }
      const saved = await ctx.config.save({
        ...config,
        models: [...config.models, model],
      })
      if (!isOk(saved)) return fail("could not save model")
      return model
    },

    updateModel: async ({ id, input }) => {
      const config = await loadConfig()
      const next: ModelRoute = {
        id,
        providerId: input.providerId,
        providerModel: input.providerModel,
        aliases: input.aliases,
      }
      const models = config.models.map((m) => (m.id === id ? next : m))
      const saved = await ctx.config.save({ ...config, models })
      if (!isOk(saved)) return fail("could not update model")
      return next
    },

    deleteModel: async ({ id }) => {
      const config = await loadConfig()
      const models = config.models.filter((m) => m.id !== id)
      const saved = await ctx.config.save({ ...config, models })
      if (!isOk(saved)) return fail("could not delete model")
      return null
    },

    // ── Harnesses ──────────────────────────────────────────────────────────────────────
    getHarnesses: async () => {
      const listed = await ctx.registry.list()
      if (!isOk(listed)) return fail("could not list harnesses")
      return listed.value.map((def) => ({
        ...def,
        native: ctx.driverRegistry.isNative(def.id),
      }))
    },

    launchHarness: async ({ id, modelId, name, cwd, env }) => {
      // Guarantee the deferred GUI PATH enrichment has settled before `Bun.which(command, { PATH })`
      // runs in `ctx.runner.launch(...)`. Without this await, a launch arriving before the
      // memoized login-shell probe settles races the probe and may fail with
      // "failed to resolve harness launch: command not found on PATH".
      await ctx.ensureGuiPathResolved()
      const config = await loadConfig()
      const listed = await ctx.registry.list()
      if (!isOk(listed)) return fail("could not list harnesses")
      const harness = listed.value.find((h) => h.id === id)
      if (harness === undefined) return fail(`unknown harness: ${String(id)}`)

      // Restore the last-used permission mode for this harness (persisted per-harness). Stored as a
      // plain string; coerce against the canonical PermissionMode and ignore anything unrecognized.
      const storedMode =
        config.settings.lastByHarness?.[String(harness.id)]?.mode
      const parsedMode =
        storedMode === undefined
          ? undefined
          : PermissionModeSchema.safeParse(storedMode)
      const permissionMode = parsedMode?.success ? parsedMode.data : undefined

      // Restore the last-used thinking-effort tier for this harness. Stored as a plain string;
      // validate against the canonical ThinkingEffortSchema and ignore anything unrecognized.
      const storedEffort =
        config.settings.lastByHarness?.[String(harness.id)]?.thinkingEffort
      const parsedEffort =
        storedEffort === undefined
          ? undefined
          : ThinkingEffortSchema.safeParse(storedEffort)
      const thinkingEffort = parsedEffort?.success
        ? parsedEffort.data
        : undefined

      // Resolve the effective model: an explicit launch model wins; else the remembered per-harness
      // one. A remembered "" means the user chose "default" (subscription) — honor it as direct.
      // Otherwise, when models are configured, default to the first so a new session is proxied
      // from turn one (the in-session picker can still switch to "default").
      const stored = config.settings.lastByHarness?.[String(id)]?.modelId
      const rememberedDefault = stored === "" // explicit subscription choice
      const effectiveModelId: ModelId | undefined =
        modelId ??
        (stored !== undefined && stored !== ""
          ? (stored as ModelId)
          : rememberedDefault
            ? undefined
            : config.models[0]?.id)

      // modelId present → route through the proxy; absent → "default" = bypass the proxy.
      let route: import("@spectrum/harnesses").LaunchRoute
      if (effectiveModelId === undefined) {
        route = { kind: "direct" }
      } else {
        const proxyUrl = `http://${config.settings.proxyHost}:${ctx.proxyPort}`
        // The session's SELECTED model id is encoded into the proxy token so the running proxy can
        // route any sub-agent / background / review request that isn't this exact id back to it.
        // SECURITY: never log proxyKey or the rendered env.
        const proxyKey = await ctx.mintSessionProxyKey(String(effectiveModelId))
        route = {
          kind: "proxied",
          proxyUrl,
          proxyKey,
          modelId: effectiveModelId,
        }
      }

      // Resolve the command (+ render the proxy env for a proxied route) WITHOUT spawning.
      const resolved = ctx.resolveLaunch({ harness, route })
      if (!isOk(resolved))
        return fail(
          `failed to resolve harness launch: ${describeError(resolved.error)}`,
        )

      // Defense in depth: coerce empty/blank name & cwd to undefined so no path
      // ever creates a session with name:"" (which fails SessionSchema's min(1)
      // on the next getSessions) or an empty cwd. The webview already omits them,
      // but a future caller — or the tray — must not be able to slip a "" through.
      const safeName = name?.trim() ? name : undefined
      const safeCwd = cwd?.trim() ? cwd : undefined

      // Every launchable harness is native now — it launches through the RunManager. A harness
      // without a registered driver has no way to run, so reject it rather than silently no-op.
      if (!ctx.driverRegistry.isNative(harness.id))
        return fail("harness has no native driver")

      const launchedNative = ctx.runner.launch({
        harnessId: harness.id,
        ...(effectiveModelId === undefined
          ? {}
          : { modelId: effectiveModelId }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
        env: { ...resolved.value.env, ...(env ?? {}) },
        cwd: safeCwd ?? "",
        // The SDK-backed driver spawns this resolved `claude` binary directly — its own
        // bundle-relative executable resolution finds no cli.js in the packaged app.
        command: resolved.value.command,
        // Forward the resolved launch args too: codex routes through the proxy ONLY via its
        // `-c model_providers.spectrum.*` overrides (not env), so a native codex session needs
        // them. Drivers that route via env ignore this.
        args: resolved.value.args,
        ...(safeName === undefined ? {} : { name: safeName }),
      })
      if (!isOk(launchedNative)) return fail("failed to launch native harness")

      // Remember the launched harness/cwd so the New Session modal can prefill them next
      // time. Persist on success only (a cancelled modal must not change the prefill). Harness
      // is always recorded; the folder is only updated when a cwd was actually given
      // (otherwise the previously remembered folder is kept). Model persistence happens
      // through the composer's `updateHarnessPrefs` instead. A save failure here is
      // non-fatal — the session already launched.
      await ctx.config.save({
        ...config,
        settings: {
          ...config.settings,
          lastSelectedHarnessId: harness.id,
          ...(safeCwd === undefined ? {} : { lastSelectedFolder: safeCwd }),
        },
      })
      return { sessionId: launchedNative.value.sessionId }
    },

    // ── Sessions & proxy ─────────────────────────────────────────────────────────────────
    getSessions: async (filter) => {
      // Build a SessionFilter from IPC params, handling exactOptionalPropertyTypes
      const sessionFilter =
        filter === undefined
          ? undefined
          : (Object.fromEntries(
              Object.entries(filter).filter(([, v]) => v !== undefined),
            ) as import("@spectrum/sessions").SessionFilter)
      const queried = ctx.sessions.query(sessionFilter)
      if (!isOk(queried)) return fail("could not query sessions")
      return [...queried.value]
    },

    deleteSession: async ({ sessionId }) => {
      const deleted = ctx.dataAdmin.deleteSession(sessionId)
      if (!isOk(deleted)) return fail("could not delete session")
      return null
    },

    renameSession: async ({ sessionId, name }) => {
      const trimmed = name.trim()
      if (trimmed === "") return fail("a session name is required")
      const updated = ctx.sessions.updateName(sessionId, trimmed)
      if (!isOk(updated))
        return fail(
          updated.error.kind === "not-found"
            ? "session not found"
            : "could not rename session",
        )
      // Stop a live run from clobbering the user's manual rename with a later
      // auto/harness-derived name. No-op if the run already ended or is unknown.
      ctx.runner.markUserNamed(sessionId)
      return null
    },

    getProxyStatus: async () => {
      const running = await ctx.proxy.isRunning(ctx.proxyBaseUrl)
      return { running, port: ctx.proxyPort }
    },

    getRunnerSocketUrl: async () => ({ url: ctx.runnerSocketUrl }),

    getUpdateSocketUrl: async () => ({ url: ctx.updateSocketUrl }),

    // ── Terminal (in-app terminal panel) ──────────────────────────────────────
    // The terminal socket URL is wired in Task 7; the handler is registered here so the contract
    // is complete and only the composition needs to add the `terminalSocketUrl` field.
    getTerminalSocketUrl: async () => ({ url: ctx.terminalSocketUrl }),

    resolveTerminalCwd: async ({ sessionId }) => {
      // Look up the session row (which retains projectId) + the project path. The public Session
      // type drops projectId, but the DB row carries it; the bun-side row resolver exposes it.
      const row = await ctx.resolveSessionRow(sessionId)
      const projectPath =
        row?.projectId !== undefined
          ? await ctx.resolveProjectPath(row.projectId)
          : undefined
      const r = await resolveTerminalCwd({
        sessionId,
        sessionCwd: row?.cwd,
        projectPath,
        homeDir: ctx.homeDir,
        exists: fsExists,
      })
      if (!r.ok) {
        // `cwd-missing` is a user-actionable condition (the session's saved directory no longer
        // exists). Surface the failed path cleanly in the IPC error detail so logs see it;
        // `useTerminal` handles the resulting `handler-failed` via the notifications engine.
        const detail =
          r.error.kind === "cwd-missing"
            ? `cwd-missing: ${r.error.path}`
            : `terminal-cwd: ${r.error.kind}`
        return fail(detail)
      }
      return r.value
    },

    // ── Run events (canonical replay) ────────────────────────────────────────────
    getRunEvents: async ({ id }) => {
      const read = ctx.runEvents.read(id)
      if (!isOk(read)) return fail("could not read run events")
      return { events: [...read.value] }
    },

    getSettings: async () => {
      const config = await loadConfig()
      return {
        lastSelectedFolder: config.settings.lastSelectedFolder,
        lastSelectedHarnessId: config.settings.lastSelectedHarnessId,
        collapsedProjects: config.settings.collapsedProjects,
      }
    },

    getTimeoutSettings: async () => {
      const config = await loadConfig()
      return {
        firstTokenTimeoutMs: config.settings.firstTokenTimeoutMs,
        interTokenTimeoutMs: config.settings.interTokenTimeoutMs,
      }
    },

    updateTimeoutSettings: async ({
      firstTokenTimeoutMs,
      interTokenTimeoutMs,
    }) => {
      const config = await loadConfig()
      const saved = await ctx.config.save({
        ...config,
        settings: {
          ...config.settings,
          firstTokenTimeoutMs,
          interTokenTimeoutMs,
        },
      })
      if (!isOk(saved)) return fail("could not save timeout settings")
      return null
    },

    getSessionNamingSettings: async () => {
      const config = await loadConfig()
      return { sessionNameModelId: config.settings.sessionNameModelId ?? null }
    },

    updateSessionNamingSettings: async ({ sessionNameModelId }) => {
      const config = await loadConfig()
      const saved = await ctx.config.save({
        ...config,
        settings: { ...config.settings, sessionNameModelId },
      })
      if (!isOk(saved)) return fail("could not save session naming settings")
      return null
    },

    // ── Projects ──────────────────────────────────────────────────────────────
    getProjects: async () => {
      const result = ctx.projects.list()
      if (!isOk(result)) return fail("could not list projects")
      return result.value.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        sessionCount: p.sessionCount,
      }))
    },

    setCollapsedProjects: async ({ ids }) => {
      const config = await loadConfig()
      const saved = await ctx.config.save({
        ...config,
        settings: { ...config.settings, collapsedProjects: ids },
      })
      if (!isOk(saved)) return fail("could not save collapsed projects")
      return null
    },

    deleteProject: async ({ projectId }) => {
      const deleted = ctx.dataAdmin.deleteProject(projectId)
      if (!isOk(deleted)) return fail("could not delete project")
      return null
    },

    // ── Data (factory reset) ────────────────────────────────────────────────
    resetApp: async () => {
      const reset = await ctx.resetApp()
      if (!isOk(reset)) return fail("could not reset app")
      return null
    },

    updateHarnessPrefs: async ({
      harnessId,
      mode,
      modelId,
      thinkingEffort,
    }) => {
      const config = await loadConfig()
      const prev = config.settings.lastByHarness ?? {}
      const key = String(harnessId)
      const nextEntry = {
        ...(prev[key] ?? {}),
        ...(mode === undefined ? {} : { mode }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
      }
      const saved = await ctx.config.save({
        ...config,
        settings: {
          ...config.settings,
          lastByHarness: { ...prev, [key]: nextEntry },
        },
      })
      if (!isOk(saved)) return fail("could not save harness prefs")
      return null
    },

    // ── Updates ──────────────────────────────────────────────────────────────
    getUpdateState: async () => buildUpdateState(),

    checkForUpdate: async () => {
      const config = await loadConfig()
      // A failed check is non-fatal — the adapter records phase "error" in its
      // raw snapshot; we do NOT re-throw so the webview gets the error state.
      await ctx.updater.check(config.settings.updateChannel as Channel)
      const state = await buildUpdateState()
      // Also push so any webview listening on the update socket sees the fresh state.
      void ctx.pushUpdateState()
      return state
    },

    startUpdateDownload: async () => {
      ctx.updater.startDownload()
      return null
    },

    applyUpdate: async () => {
      // Fire-and-forget: apply() may relaunch the app and never return.
      void ctx.updater.apply()
      return null
    },

    dismissUpdate: async ({ hash }: { hash: string }) => {
      const config = await loadConfig()
      const saved = await ctx.config.save({
        ...config,
        settings: {
          ...config.settings,
          // Dismissal keys on the build `hash` (unique per build for both
          // channels). `dismissedUpdateVersion` is kept in sync as a legacy
          // fallback for any older build that reports no hash; the source of
          // truth is `dismissedUpdateHash`. See policy.ts.
          dismissedUpdateHash: hash,
          dismissedUpdateVersion: config.settings.dismissedUpdateVersion,
        },
      })
      if (!isOk(saved)) return fail("could not persist dismissed update")
      return null
    },

    setUpdateChannel: async ({ channel }: { channel: Channel }) => {
      const config = await loadConfig()
      // Capture the build's CURRENT channel BEFORE setChannel rewrites version.json
      // (setChannel also rewrites `name` on a cross-channel switch — see the adapter).
      // A cross-channel switch from a PACKAGED build (stable↔canary) is a migration:
      // Electrobun caches localInfo for the process lifetime, so the rewritten
      // version.json only takes effect after a restart. Relaunch the app instead of
      // re-checking (the post-switch check would query the STALE cached channel and
      // report a stable update against the canary UI — the "download fails, button
      // reappears" bug). The relaunch is fire-and-forget like applyUpdate; the
      // returned state is the pre-switch snapshot (the connection dies on quit).
      const fromChannel = await ctx.updater.getBuildChannel()
      const saved = await ctx.config.save({
        ...config,
        settings: { ...config.settings, updateChannel: channel },
      })
      if (!isOk(saved)) return fail("could not persist update channel")
      const switched = await ctx.updater.setChannel(channel)
      if (!isOk(switched)) return fail("could not switch update channel")
      // Cross-channel migration: relaunch so the fresh process loads the rewritten
      // version.json. Skip the re-check (it would hit the stale cached feed). A
      // same-channel switch, or an unknown build channel (dev), is a preference
      // persist — re-check and return fresh state, no relaunch.
      if (fromChannel !== undefined && fromChannel !== channel) {
        const relaunched = await ctx.updater.relaunch()
        if (!isOk(relaunched))
          return fail("could not restart to switch channel")
        // The app is quitting; return the pre-switch state (the webview won't
        // observe it — the process exits mid-RPC like applyUpdate).
        return buildUpdateState()
      }
      await ctx.updater.check(channel)
      const state = await buildUpdateState()
      void ctx.pushUpdateState()
      return state
    },

    // ── Dialogs ───────────────────────────────────────────────────────────────
    pickFolder: async (params) => {
      const startingFolder = params?.startingFolder
      const selected = await ctx.pickFolder(
        startingFolder === undefined ? {} : { startingFolder },
      )
      const first = selected[0]
      return first === undefined ? {} : { path: first }
    },

    // ── External links ──────────────────────────────────────────────────────
    openExternalUrl: async ({ url }) => {
      const opened = await ctx.openExternalUrl(url)
      if (!opened) return fail("could not open url in default browser")
      return null
    },

    // ── Media uploads (file picker → uploads dir → data URL / external open) ──
    pickUploads: async (params) => {
      const paths = await ctx.pickFiles()
      const acceptedKinds = new Set<AttachmentKind>(params.acceptedKinds)
      const uploads: AttachmentRef[] = []
      const rejected: { displayName: string; reason: "unsupported-kind" }[] = []
      const errors: {
        displayName: string
        reason: "io-failed" | "too-large"
      }[] = []
      for (const p of paths) {
        if (p.trim() === "") continue
        const displayName = p.split("/").pop() ?? p
        const mime = mimeFromExt(displayName)
        const kind = inferKind(mime, displayName)
        if (!acceptedKinds.has(kind)) {
          rejected.push({ displayName, reason: "unsupported-kind" })
          continue
        }
        const res = await ctx.uploadStore.save({
          sourcePath: p,
          mime,
          displayName,
          maxBytes: 10 * 1024 * 1024,
        })
        if (res.ok) {
          uploads.push(res.value.ref)
        } else {
          // An IO error is user-actionable: return it so the webview can toast
          // the user that the file wasn't attached. (See docs/01-conventions/notifications.md.)
          ctx.log.child("uploads").error("upload save failed", {
            displayName,
            kind: res.error.kind,
            detail: res.error.detail,
          })
          if (res.error.kind === "too-large") {
            errors.push({ displayName, reason: "too-large" })
          } else {
            errors.push({ displayName, reason: "io-failed" })
          }
        }
      }
      const out: {
        uploads: AttachmentRef[]
        rejected?: { displayName: string; reason: "unsupported-kind" }[]
        errors?: { displayName: string; reason: "io-failed" | "too-large" }[]
      } = { uploads }
      if (rejected.length > 0) out.rejected = rejected
      if (errors.length > 0) out.errors = errors
      return out
    },

    readUploadThumbnail: async ({ id, mime }) => {
      const exists = await ctx.uploadStore.exists(id)
      if (!exists) return { missing: true }
      const r = await ctx.uploadStore.readBase64(id)
      if (!r.ok) return { missing: true }
      return { dataUrl: toDataUrl(mime, r.value) }
    },

    readUploadDataUrl: async ({ id, mime }) => {
      const exists = await ctx.uploadStore.exists(id)
      if (!exists) return { missing: true }
      const r = await ctx.uploadStore.readBase64(id)
      if (!r.ok) return { missing: true }
      return { dataUrl: toDataUrl(mime, r.value) }
    },

    openUploadExternal: async ({ id }) => {
      const r = await ctx.uploadStore.pathOf(id)
      if (!r.ok) return { missing: true }
      const filePath = r.value
      // SECURITY: the path comes from UploadStore (closed set inside `uploads/`),
      // but defend in depth — reject anything that somehow escapes. An
      // `isAbsolute` check + `uploadsDir` prefix check catches traversal/escape
      // on every supported platform (POSIX `/...` and Windows `C:\...`).
      const isAbsolute =
        path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)
      if (!filePath.startsWith(ctx.paths.uploadsDir) || !isAbsolute) {
        ctx.log
          .child("uploads")
          .error("openUploadExternal: path escaped uploadsDir", {
            id,
            path: filePath,
          })
        return { opened: false }
      }
      const opened = await ctx.openExternalUrl(`file://${filePath}`)
      if (!opened) return fail("could not open upload in default viewer")
      return null
    },

    // ── Model discovery ────────────────────────────────────────────────────────
    listProviderModels: async ({ providerId }) => {
      const result = await ctx.listProviderModels(String(providerId))
      if (!isOk(result))
        return fail(
          `could not list provider models: ${describeError(result.error)}`,
        )
      return { models: [...result.value] }
    },

    // Draft (un-saved) probes — validate inline config then delegate to AppContext.
    testProviderDraft: async ({
      sdkProvider,
      config,
      secrets,
      providerModel,
    }) => {
      const valid = validateProviderConfig(sdkProvider, config)
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      // A connectivity probe needs a model to ping; fall back to the sdkProvider name
      // when none was chosen yet (mirrors testProvider's provider.models[0] ?? id fallback).
      const model = providerModel.trim() !== "" ? providerModel : sdkProvider
      const result = await ctx.testProviderDraft({
        sdkProvider,
        config,
        secrets,
        providerModel: model,
      })
      if (!isOk(result))
        return fail(
          `provider draft test failed: ${describeError(result.error)}`,
        )
      return result.value
    },

    listProviderModelsDraft: async ({ sdkProvider, config, secrets }) => {
      const valid = validateProviderConfig(sdkProvider, config)
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      const result = await ctx.listProviderModelsDraft({
        sdkProvider,
        config,
        secrets,
      })
      if (!isOk(result))
        return fail(
          `could not list provider models: ${describeError(result.error)}`,
        )
      return { models: [...result.value] }
    },

    // ── Client logging ──────────────────────────────────────────────────────
    logClientError: async ({ scope, level, msg, fields }) => {
      const child = ctx.log.child(`webview.${scope}`)
      if (level === "fatal") child.fatal(msg, fields)
      else child.error(msg, fields)
      return null
    },
  }
}
