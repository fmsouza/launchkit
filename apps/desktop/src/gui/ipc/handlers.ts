import { stat } from "node:fs/promises"
import path from "node:path"

import {
  PermissionModeSchema,
  ThinkingEffortSchema,
} from "@spectrum/agent-events"
import type { Config, PluginInstall } from "@spectrum/config"
import type {
  FlowStep,
  LoadedExtension,
  PluginError,
} from "@spectrum/extensions"
import type {
  ContributedProviderView,
  ExtensionView,
  FlowStepViewData,
  FlowToastViewData,
  IpcHandlers,
  ProviderView,
} from "@spectrum/ipc"
import { FlowStepViewSchema } from "@spectrum/ipc"
import type { FlowCompletion, RunnerStep } from "@spectrum/provider-host"
import { FLOW_IN_FLIGHT_DETAIL } from "@spectrum/provider-host"
import {
  heuristicAttachments,
  validateProviderConfig,
} from "@spectrum/providers"
import { providerInstanceKey } from "@spectrum/proxy"
import {
  SdkProviderSchema,
  pluginIdOf,
  pluginKeyOf,
  wireModelFor,
} from "@spectrum/types"
import type { ModelId, ModelRoute, Provider, SecretRef } from "@spectrum/types"
import { isOk } from "@spectrum/utils"
import type { GuiContext } from "../../composition"
import { buildUpdateState as buildUpdateStateShared } from "../updater/build-update-state"
import type { Channel } from "../updater/updater-adapter"
import { flowErrorMessage } from "./flow-errors"
import { ingestUploads } from "./ingest-uploads"
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

/** Format a base64 string as a `data:<mime>;base64,...` URL. */
const toDataUrl = (mime: string, base64: string): string =>
  `data:${mime};base64,${base64}`

/**
 * Human-readable detail for a `PluginError`, exhaustive over the closed union
 * (`@spectrum/extensions`). Used both for `listExtensions`'s "which extension is broken and
 * why" surfacing and for every other extension-admin failure passed to `fail()`. Never a
 * secret — `PluginError` never carries one.
 */
const describePluginError = (e: PluginError): string => {
  switch (e.kind) {
    case "invalid-manifest":
      return e.id === undefined
        ? `invalid extension manifest: ${e.detail}`
        : `invalid extension manifest for "${e.id}": ${e.detail}`
    case "unsupported-api-version":
      return e.id === undefined
        ? `extension needs a newer version of Spectrum (apiVersion "${e.apiVersion}")`
        : `extension "${e.id}" needs a newer version of Spectrum (apiVersion "${e.apiVersion}")`
    case "duplicate-id":
      return `duplicate extension id "${e.id}"`
    case "read-failed":
      return `could not read: ${e.detail}`
    case "write-failed":
      return `could not write: ${e.detail}`
    case "not-found":
      return `extension not found: ${e.id}`
    case "in-use":
      return `extension "${e.id}" is in use by ${e.providerIds.join(", ")}`
    case "git-failed":
      return `git failed: ${e.detail}`
    case "source-unavailable":
      return `source unavailable: ${e.path}`
  }
}

/**
 * Project one extension's provider contributions to the IPC view. SECURITY (spec §3):
 * `launchCommand`/`launchArgs` are the UNRENDERED manifest templates (never rendered — a
 * rendered arg list can carry a resolved secret) and there is no `env` field at all. Status is
 * looked up by INSTANCE KEY, not by contribution id: a contribution with no configured
 * provider record has no child, so it is `"stopped"`.
 */
const toContributedProviderViews = (
  extension: LoadedExtension,
  config: Config,
  providerHost: GuiContext["providerHost"],
): ContributedProviderView[] =>
  // The explicit `: ContributedProviderView` return-type annotation is load-bearing, not
  // decorative: a plain inferred-return arrow inside `.map()` loses object-literal
  // "freshness", so TypeScript's excess-property check silently stops applying and an
  // accidental extra field (an `instanceKey`, a stray `env`) compiles clean. Annotating the
  // callback restores the same excess-property check `toExtensionView` gets for free from
  // being a directly-typed expression body.
  extension.manifest.contributes.providers.map(
    (contribution): ContributedProviderView => {
      const key = pluginKeyOf(contribution.id)
      const launch = contribution.transport.launch
      const statuses = config.providers
        .filter((p) => p.sdkProvider === key)
        .map((p) =>
          providerHost.status(
            providerInstanceKey({
              sdkProvider: p.sdkProvider,
              config: p.config,
              secretRefs: p.secrets,
            }),
          ),
        )
      return {
        key,
        label: contribution.descriptor.label,
        status: statuses.find((s) => s !== "stopped") ?? "stopped",
        ...(launch === undefined
          ? {}
          : { launchCommand: launch.command, launchArgs: [...launch.args] }),
        secretFieldNames: contribution.descriptor.secretFields.map(
          (f) => f.name,
        ),
      }
    },
  )

/** Project a loaded (parsed, on-disk) extension + its install record (if any) to the IPC view.
 * No install record ⇒ a hand-placed directory: `source: { kind: "local" }`, `enabled: false`
 * (`adapters.ts` scans every subdirectory of the plugin root, installed or not). */
const toExtensionView = (
  extension: LoadedExtension,
  install: PluginInstall | undefined,
  config: Config,
  providerHost: GuiContext["providerHost"],
): ExtensionView => ({
  id: String(extension.manifest.id),
  name: extension.manifest.name,
  version: extension.manifest.version,
  ...(extension.manifest.description === undefined
    ? {}
    : { description: extension.manifest.description }),
  enabled: install?.enabled ?? false,
  source: install?.source ?? { kind: "local" },
  unavailable: false,
  ignoredContributions: [...extension.ignoredContributions],
  providers: toContributedProviderViews(extension, config, providerHost),
})

/**
 * Reconstruct the row for a linked install whose source directory has vanished:
 * `registry.list()` skips it (source-unavailable, logged there) rather than failing the whole
 * batch, so this is built from the install record ALONE — no manifest to read `name`/`version`
 * from, and no contributed providers (nothing to spawn from a manifest we can't read).
 */
const toUnavailableExtensionView = (install: PluginInstall): ExtensionView => ({
  id: String(install.id),
  name: String(install.id),
  version: "unknown",
  enabled: install.enabled,
  source: install.source,
  unavailable: true,
  ignoredContributions: [],
  providers: [],
})

/**
 * What a live setup-flow session is FOR.
 *
 * `advanceProviderFlow` carries only a session id, but a `done` step almost always arrives on
 * an ADVANCE, and persisting it needs the provider key and the context the flow was STARTED
 * with. Kept main-side rather than accepted back from the renderer on every call: which
 * provider record a completed flow writes to must not be a value the webview supplies.
 */
type FlowOrigin = {
  readonly providerKey: string
  readonly context: "create" | "provider"
  readonly providerId: string | undefined
  /** The config the flow was started with — merged under whatever `done.config` returns. */
  readonly config: Readonly<Record<string, string>>
}

/** A terminal step the renderer can render as-is. */
const flowErrorStep = (message: string): FlowStepViewData => ({
  kind: "error",
  message,
})

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
   * Join `ctx.extensionRegistry.list()` with `config.providerPlugins`: every parsed extension
   * (installed or hand-placed) plus a reconstructed row for every linked install the registry
   * skipped as source-unavailable. Shared by `listExtensions` and every mutation, which return
   * the refreshed list so the page needs no second round trip. A registry failure (an
   * unsupported api version, a duplicate id, an invalid manifest — a REAL error, not the
   * source-unavailable case, which the registry itself already skips) fails loudly with the
   * offending kind and identifying field, never collapsed to a generic message.
   */
  const listExtensionViews = async (): Promise<ExtensionView[]> => {
    const config = await loadConfig()
    const listed = await ctx.extensionRegistry.list()
    if (!isOk(listed))
      return fail(
        `could not list extensions: ${describePluginError(listed.error)}`,
      )

    const installs = config.providerPlugins
    const listedIds = new Set(listed.value.map((e) => String(e.manifest.id)))

    const views = listed.value.map((extension) =>
      toExtensionView(
        extension,
        installs.find((i) => String(i.id) === String(extension.manifest.id)),
        config,
        ctx.providerHost,
      ),
    )
    const unavailableViews = installs
      .filter((i) => !listedIds.has(String(i.id)))
      .map(toUnavailableExtensionView)

    return [...views, ...unavailableViews]
  }

  /**
   * Thin wrapper: delegates to the shared `buildUpdateState` helper (extracted
   * to `../updater/build-update-state.ts`) so there is one source of truth for
   * how `UpdateState` is assembled from the raw adapter snapshot + config.
   */
  const buildUpdateState = async (): Promise<
    import("@spectrum/ipc").IpcMethods["getUpdateState"]["result"]
  > => buildUpdateStateShared({ updater: ctx.updater, config: ctx.config })

  // ── Provider setup flows ───────────────────────────────────────────────────
  const flowLog = ctx.log.child("ipc.flow")
  const flowOrigins = new Map<string, FlowOrigin>()

  /**
   * Project a runner step onto the sanitized view that may cross IPC.
   *
   * The `done` variant is REBUILT from its message alone — never spread — so `config`,
   * `secrets`, or any field a future plugin adds cannot ride along; every other kind is
   * already credential-free. The projection is then parsed by `FlowStepViewSchema`, so a
   * mistake here fails loudly in the main process rather than leaking to the renderer.
   */
  const sanitizeFlowStep = (step: FlowStep): FlowStepViewData => {
    const view =
      step.kind === "done"
        ? {
            kind: "done" as const,
            ...(step.message === undefined ? {} : { message: step.message }),
          }
        : step
    const parsed = FlowStepViewSchema.safeParse(view)
    if (!parsed.success)
      return fail(`could not project flow step of kind: ${step.kind}`)
    return parsed.data
  }

  /**
   * Persist a completed flow's output. Returns a user-facing message when it REFUSES, or
   * `undefined` on success.
   *
   * Order is fixed and load-bearing: validate the record the same way `addProvider` validates
   * its own (so a flow cannot write a provider the GUI would have rejected), THEN the keychain
   * writes (skipped entirely on a refusal, so no orphan keychain entries), THEN `config.save`
   * — which is what triggers the composition root's retention sweep for the new configuration.
   *
   * The record is SAVED, not handed back as a draft: `resolveBaseUrl` refuses a supervised
   * contribution with no instance key, so a draft produced by a flow could be neither tested
   * nor have its models discovered.
   */
  const persistFlowCompletion = async (
    origin: FlowOrigin,
    completion: FlowCompletion,
  ): Promise<string | undefined> => {
    const loaded = await ctx.config.load()
    if (!isOk(loaded))
      return "Setup finished, but Spectrum could not read its configuration to save the provider."
    const config = loaded.value

    const existing =
      origin.context === "provider"
        ? config.providers.find((p) => String(p.id) === origin.providerId)
        : undefined
    // Re-checked at DONE, not only at start: a flow lives for up to ten minutes, and
    // `updateProvider` can point that same record at a different provider in the meantime.
    // Merging this flow's config and credentials into it then would be a cross-provider write.
    if (
      origin.context === "provider" &&
      (existing === undefined || existing.sdkProvider !== origin.providerKey)
    )
      return "Setup finished, but the provider it was set up for is no longer available."

    // Precedence, deliberately: stored config < the config the flow was STARTED with < what
    // `done.config` returned. The flow's own values win, and what the user typed before
    // starting it is not discarded. On the `provider` path that makes `startProviderFlow` an
    // alternative config-write path for an existing record — intended, because the modal
    // passes what the user is currently looking at, and the merged result goes through the
    // same `validateProviderConfig` gate `updateProvider` applies.
    const merged = {
      ...(existing?.config ?? {}),
      ...origin.config,
      ...completion.config,
    }

    const valid = validateProviderConfig(
      ctx.providerRegistry,
      origin.providerKey,
      merged,
    )
    if (!valid.ok)
      return `Setup finished, but Spectrum could not save the provider: the settings it produced were rejected (${valid.error.kind}).`

    // The descriptor is guaranteed to resolve: `validateProviderConfig` above looked the same
    // key up in the same registry and returned `unsupported-provider` if it did not. The
    // fallbacks below are therefore type-level only — and both fail CLOSED.
    const descriptor = ctx.providerRegistry.get(origin.providerKey)

    // Filter against the DECLARED secret fields before touching the keychain. This is the
    // authoritative list (the manifest's own), so it is stronger than `addProvider`'s filter
    // over renderer-supplied names — and it BOUNDS THE LOOP: without it the number of keychain
    // round trips a `done` step can drive is capped only by `FLOW_LIMITS.maxBodyBytes`, so a
    // buggy or hostile extension could force thousands of them.
    const declared = new Set(
      (descriptor?.secretFields ?? []).map((f) => f.name),
    )
    const incoming = Object.entries(completion.secrets).filter(([field]) =>
      declared.has(field),
    )

    // Each secret VALUE goes to the keychain; only the returned ref is ever persisted.
    const secrets: Record<string, SecretRef> = { ...(existing?.secrets ?? {}) }
    for (const [field, value] of incoming) {
      if (value === "") continue
      const set = await ctx.secrets.set(value)
      if (!isOk(set))
        return "Setup finished, but Spectrum could not store the credential in your keychain."
      secrets[field] = set.value
    }

    // Same id minting as `addProvider`. The NAME differs deliberately: `addProvider` falls
    // back to the raw key because its caller can supply one, while these params carry no
    // `name` at all — so the descriptor's label is the only chance this record has at being
    // called "Acme" instead of "plugin:acme".
    const provider: Provider =
      existing === undefined
        ? {
            id: `p_${crypto.randomUUID()}` as Provider["id"],
            name: descriptor?.label ?? origin.providerKey,
            sdkProvider: origin.providerKey,
            config: merged,
            secrets,
            models: [],
          }
        : { ...existing, config: merged, secrets }
    const providers =
      existing === undefined
        ? [...config.providers, provider]
        : config.providers.map((p) => (p.id === existing.id ? provider : p))

    const saved = await ctx.config.save({ ...config, providers })
    if (!isOk(saved))
      return "Setup finished, but Spectrum could not save the provider."
    flowLog.info("flow provider saved", { context: origin.context })
    return undefined
  }

  /**
   * Post-process a runner step server-side, BEFORE it crosses to the renderer.
   *
   * - `open-external` is opened here, through the guarded capability. The renderer is never
   *   told to open anything itself: the scheme guard lives main-side, and opening on delivery
   *   is the ordinary shape of an OAuth handoff.
   * - `done` drains the completion (one read, ever) and persists it. Only the sanitized
   *   message-only step goes back.
   */
  const deliverFlowStep = async (
    stepped: RunnerStep,
    origin: FlowOrigin,
  ): Promise<{
    readonly step: FlowStepViewData
    readonly toast?: FlowToastViewData
  }> => {
    const toast =
      stepped.toast === undefined ? {} : { toast: { ...stepped.toast } }
    const step = stepped.step
    flowLog.debug("flow step delivered", { kind: step.kind })

    if (step.kind === "open-external") {
      const opened = await ctx.openExternalGuarded(step.url)
      if (!isOk(opened)) {
        flowLog.warn("flow could not open the browser", {
          kind: opened.error.kind,
        })
        return {
          step: flowErrorStep(
            "Spectrum could not open your browser for this step.",
          ),
          ...toast,
        }
      }
    }

    if (step.kind === "done") {
      flowOrigins.delete(stepped.sessionId)
      const completion = ctx.flowRunner.takeCompletion(stepped.sessionId)
      // The runner stashes a completion on EVERY `done`, so `undefined` means this `done` was
      // delivered twice (or replayed) and the payload was already drained. Reporting the
      // plugin's "Signed in" here would tell the user setup succeeded while nothing was
      // saved — a silent wrong-success is worse than a loud unreachable error.
      if (completion === undefined)
        return {
          step: flowErrorStep(
            "Setup finished, but Spectrum did not receive its result, so nothing was saved. Please run the setup again.",
          ),
          ...toast,
        }
      const refusal = await persistFlowCompletion(origin, completion)
      if (refusal !== undefined)
        return { step: flowErrorStep(refusal), ...toast }
    }
    if (step.kind === "error") flowOrigins.delete(stepped.sessionId)

    return { step: sanitizeFlowStep(step), ...toast }
  }

  /** Log the failure (kind only — a detail can echo extension-controlled text) and map it. */
  const flowFailure = (error: PluginError): FlowStepViewData => {
    flowLog.warn("flow step failed", { kind: error.kind })
    return flowErrorStep(flowErrorMessage(error))
  }

  return {
    // ── Providers ──────────────────────────────────────────────────────────────────────
    getProviders: async () => {
      const config = await loadConfig()
      return config.providers.map(toProviderView)
    },

    getProviderCatalog: async () => [...ctx.providerRegistry.catalog()],

    addProvider: async (input) => {
      const config = await loadConfig()
      const valid = validateProviderConfig(
        ctx.providerRegistry,
        input.sdkProvider,
        input.config,
      )
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
      const valid = validateProviderConfig(
        ctx.providerRegistry,
        input.sdkProvider,
        input.config,
      )
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
        attachments:
          input.attachments ?? heuristicAttachments(input.providerModel),
        ...(input.attachmentsSource !== undefined
          ? { attachmentsSource: input.attachmentsSource }
          : { attachmentsSource: "auto" as const }),
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
      const existing = config.models.find((m) => m.id === id)
      const inputAttachments = input.attachments ?? {}
      const capsTouched =
        input.attachmentsSource !== undefined ||
        Object.keys(inputAttachments).length > 0
      const next: ModelRoute = {
        id,
        providerId: input.providerId,
        providerModel: input.providerModel,
        aliases: input.aliases,
        attachments: capsTouched
          ? inputAttachments
          : (existing?.attachments ?? {}),
        ...((capsTouched
          ? input.attachmentsSource
          : existing?.attachmentsSource) !== undefined
          ? {
              attachmentsSource: capsTouched
                ? input.attachmentsSource
                : existing?.attachmentsSource,
            }
          : {}),
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
        // Wire alias: the CLI name gate ships real image/PDF blocks only when the name looks like
        // a Claude model. Capability-aware routes get the claude-spectrum-<id> alias; everything
        // else (unknown / not image-capable) falls back to the raw id.
        const routeModel = config.models.find(
          (m) => String(m.id) === String(effectiveModelId),
        )
        const wireModel =
          routeModel !== undefined ? wireModelFor(routeModel) : undefined
        route = {
          kind: "proxied",
          proxyUrl,
          proxyKey,
          modelId: effectiveModelId,
          ...(wireModel !== undefined ? { wireModel } : {}),
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
      return ingestUploads({
        sources: paths.map((p) => ({ kind: "path" as const, path: p })),
        acceptedKinds: params.acceptedKinds,
        store: ctx.uploadStore,
        log: ctx.log.child("uploads"),
      })
    },

    saveDroppedUploads: async (params) =>
      ingestUploads({
        sources: params.files.map((f) => ({
          kind: "bytes" as const,
          displayName: f.displayName,
          ...(f.mime === "" ? {} : { mime: f.mime }),
          // Transport encoding (base64) is decoded at this boundary; the store sees bytes.
          data: new Uint8Array(Buffer.from(f.dataBase64, "base64")),
        })),
        acceptedKinds: params.acceptedKinds,
        store: ctx.uploadStore,
        log: ctx.log.child("uploads"),
      }),

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
      const valid = validateProviderConfig(
        ctx.providerRegistry,
        sdkProvider,
        config,
      )
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      // Connectivity probing only knows the built-in SDK providers today; a plugin key
      // has no probe path yet (tracked by the extensions-UI follow-up plan).
      const builtin = SdkProviderSchema.safeParse(sdkProvider)
      if (!builtin.success)
        return fail(`provider draft test not supported for: ${sdkProvider}`)
      // A connectivity probe needs a model to ping; fall back to the sdkProvider name
      // when none was chosen yet (mirrors testProvider's provider.models[0] ?? id fallback).
      const model = providerModel.trim() !== "" ? providerModel : sdkProvider
      const result = await ctx.testProviderDraft({
        sdkProvider: builtin.data,
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
      const valid = validateProviderConfig(
        ctx.providerRegistry,
        sdkProvider,
        config,
      )
      if (!valid.ok) return fail(`invalid provider config: ${valid.error.kind}`)
      // Model discovery only knows the built-in SDK providers today; a plugin key has no
      // discovery path yet (tracked by the extensions-UI follow-up plan).
      const builtin = SdkProviderSchema.safeParse(sdkProvider)
      if (!builtin.success)
        return fail(
          `provider model discovery not supported for: ${sdkProvider}`,
        )
      const result = await ctx.listProviderModelsDraft({
        sdkProvider: builtin.data,
        config,
        secrets,
      })
      if (!isOk(result))
        return fail(
          `could not list provider models: ${describeError(result.error)}`,
        )
      return { models: [...result.value] }
    },

    // ── Extensions (provider plugins) ─────────────────────────────────────────
    // Every mutation delegates to `ctx.extensions` (Task 4), which owns both the config write
    // AND the `refreshExtensions()` call — handlers here never write `providerPlugins` directly.
    listExtensions: async () => listExtensionViews(),

    installExtension: async (input) => {
      const installed = await ctx.extensions.install({
        source: input.source,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      })
      if (!isOk(installed))
        return fail(
          `could not install extension: ${describePluginError(installed.error)}`,
        )
      return listExtensionViews()
    },

    setExtensionEnabled: async ({ id, enabled }) => {
      const result = await ctx.extensions.setEnabled(id, enabled)
      if (!isOk(result))
        return fail(
          `could not update extension: ${describePluginError(result.error)}`,
        )
      return listExtensionViews()
    },

    updateExtension: async ({ id }) => {
      const result = await ctx.extensions.update(id)
      if (!isOk(result))
        return fail(
          `could not update extension: ${describePluginError(result.error)}`,
        )
      return listExtensionViews()
    },

    // `in-use` is returned as DATA (so the page can name the referencing providers), never as
    // a transport error; every other failure still goes through `fail()`.
    removeExtension: async ({ id }) => {
      const result = await ctx.extensions.remove(id)
      if (!isOk(result)) {
        if (result.error.kind === "in-use") {
          return {
            refused: {
              kind: "in-use" as const,
              id: result.error.id,
              providerIds: [...result.error.providerIds],
            },
          }
        }
        return fail(
          `could not remove extension: ${describePluginError(result.error)}`,
        )
      }
      return listExtensionViews()
    },

    // ── Provider setup flows ──────────────────────────────────────────────────
    // The renderer never sees `done.secrets`, an env map, a host token, or an instance key:
    // the completion is drained and written to the keychain HERE, and the step that goes back
    // is rebuilt from its message alone.
    startProviderFlow: async ({
      providerKey,
      flowId,
      context,
      config,
      providerId,
    }) => {
      // A builtin key names no process that could serve steps. Refused as an error STEP, not
      // a transport failure, so the setup modal can say so instead of blanking.
      const contributionId = pluginIdOf(providerKey)
      if (contributionId === undefined)
        return {
          step: flowFailure({ kind: "not-found", id: providerKey }),
        }

      // `context: "provider"` re-authenticates an existing record, so the plugin's child is
      // started with THAT record's secrets. A provider being created has none.
      let secrets: Record<string, string> | undefined
      if (context === "provider") {
        const loaded = await ctx.config.load()
        if (!isOk(loaded))
          return {
            step: flowErrorStep("Spectrum could not read its configuration."),
          }
        const existing = loaded.value.providers.find(
          (p) => String(p.id) === String(providerId ?? ""),
        )
        // SECURITY: the named record must actually BE this provider's. A mismatched
        // key/id pair — a renderer bug, or a record edited to another provider since the
        // page loaded — would otherwise hand ONE provider's resolved secrets to a
        // DIFFERENT extension's child process.
        if (existing === undefined || existing.sdkProvider !== providerKey)
          return {
            step: flowErrorStep(
              "Setup cannot start: that provider is not available for this setup.",
            ),
          }
        secrets = {}
        for (const [field, ref] of Object.entries(existing.secrets)) {
          const value = await ctx.secrets.get(ref)
          // A credential that has gone missing from the keychain is precisely what a re-auth
          // flow is for — start it without that field rather than refusing outright.
          if (isOk(value)) secrets[field] = value.value
          else flowLog.debug("flow secret unavailable", { field })
        }
      }

      const started = await ctx.flowRunner.start({
        providerId: contributionId,
        flowId,
        context,
        config,
        ...(secrets === undefined ? {} : { secrets }),
      })
      if (!isOk(started)) return { step: flowFailure(started.error) }

      const origin: FlowOrigin = {
        providerKey,
        context,
        providerId: providerId === undefined ? undefined : String(providerId),
        config,
      }
      flowOrigins.set(started.value.sessionId, origin)
      return {
        sessionId: started.value.sessionId,
        ...(await deliverFlowStep(started.value, origin)),
      }
    },

    advanceProviderFlow: async ({ sessionId, result }) => {
      const origin = flowOrigins.get(sessionId)
      if (origin === undefined)
        return {
          sessionId,
          step: flowFailure({ kind: "not-found", id: sessionId }),
        }

      const stepped = await ctx.flowRunner.advance({ sessionId, result })
      if (!isOk(stepped)) {
        // A SECOND call while the first is still in flight — a double-submit, or a poll
        // racing a submit. The runner refuses it without ending the flow, and only the detail
        // separates it from a genuinely dead extension, so it is answered with no step at
        // all: the renderer keeps showing what it has. Surfacing it as an error step would
        // read as "the extension stopped responding" and kill a live setup over a double click.
        if (
          stepped.error.kind === "read-failed" &&
          stepped.error.detail === FLOW_IN_FLIGHT_DETAIL
        ) {
          flowLog.debug("flow advance ignored", { reason: "already-in-flight" })
          return { sessionId }
        }
        flowOrigins.delete(sessionId)
        return { sessionId, step: flowFailure(stepped.error) }
      }

      return { sessionId, ...(await deliverFlowStep(stepped.value, origin)) }
    },

    cancelProviderFlow: async ({ sessionId }) => {
      // Symmetric with `advanceProviderFlow`: `flowRunner` is shared on the AppContext while
      // these origins are per handler set, so a session this handler set did not start is not
      // its to end either. Cancelling one would be as wrong as finishing one. A session that
      // already reached a terminal step has had its origin dropped, and the runner's own
      // `cancel` is a no-op for an unknown session, so nothing is lost by returning early.
      if (!flowOrigins.has(sessionId)) return null
      flowOrigins.delete(sessionId)
      await ctx.flowRunner.cancel(sessionId)
      return null
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
