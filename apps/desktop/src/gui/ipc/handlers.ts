import type { IpcHandlers, ProviderView } from "@launchkit/ipc"
import type { Provider, SecretRef } from "@launchkit/types"
import { isOk } from "@launchkit/utils"
import type { AppContext } from "../../composition"

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

/** Raised inside a handler so the ipc server wraps it as a typed handler-failed IpcError. */
const fail = (message: string): never => {
  throw new Error(message)
}

/**
 * Bind the `@launchkit/ipc` contract to the wired subsystems. Each handler is `async` and either
 * returns the validated result shape or throws (the ipc server turns a throw into a `handler-failed`
 * IpcError; nothing leaks a stack trace because the server stringifies `error.message` only).
 * `void` results are encoded as `null` (the ipc VoidSchema), matching `04-ipc.md`.
 */
export const createIpcHandlers = (ctx: AppContext): IpcHandlers => {
  /** Load config or throw a message-safe handler error. */
  const loadConfig = async () => {
    const loaded = await ctx.config.load()
    if (!isOk(loaded)) return fail("could not load config")
    return loaded.value
  }

  return {
    // ── Providers ──────────────────────────────────────────────────────────────────────
    getProviders: async () => {
      const config = await loadConfig()
      return config.providers.map(toProviderView)
    },

    addProvider: async (input) => {
      const config = await loadConfig()
      // Build a Provider from the NON-secret input. secrets start empty — a value can only be set
      // later via setProviderSecret, never through this path (security.md).
      const provider: Provider = {
        id: `p_${crypto.randomUUID()}` as Provider["id"],
        name: input.name,
        sdkProvider: input.sdkProvider,
        config: input.config,
        secrets: {},
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
      // Preserve existing secret refs; only non-secret fields are updatable over IPC.
      const updated: Provider = {
        ...existing,
        name: input.name,
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

    // ── Aliases ────────────────────────────────────────────────────────────────────────
    getAliases: async () => {
      const config = await loadConfig()
      return config.aliases
    },

    addAlias: async (alias) => {
      const config = await loadConfig()
      const saved = await ctx.config.save({
        ...config,
        aliases: [...config.aliases, alias],
      })
      if (!isOk(saved)) return fail("could not save alias")
      return alias
    },

    updateAlias: async ({ alias, input }) => {
      const config = await loadConfig()
      const next = {
        alias,
        providerId: input.providerId,
        providerModel: input.providerModel,
      }
      const aliases = config.aliases.map((a) => (a.alias === alias ? next : a))
      const saved = await ctx.config.save({ ...config, aliases })
      if (!isOk(saved)) return fail("could not update alias")
      return next
    },

    deleteAlias: async ({ alias }) => {
      const config = await loadConfig()
      const aliases = config.aliases.filter((a) => a.alias !== alias)
      const saved = await ctx.config.save({ ...config, aliases })
      if (!isOk(saved)) return fail("could not delete alias")
      return null
    },

    // ── Harnesses ──────────────────────────────────────────────────────────────────────
    getHarnesses: async () => {
      const listed = await ctx.registry.list()
      if (!isOk(listed)) return fail("could not list harnesses")
      return [...listed.value]
    },

    addHarness: async (definition) => {
      // User-defined harnesses are files on disk; the registry hot-reloads them. The GUI write-path
      // for harness JSON is owned by gui-pages — here we accept + echo the validated definition so
      // the contract is satisfied. (No-op persistence stub; gui-pages replaces with a file write.)
      return definition
    },

    updateHarness: async ({ id, input }) => ({ ...input, id }),

    deleteHarness: async () => null,

    launchHarness: async ({ id, alias }) => {
      const config = await loadConfig()
      const listed = await ctx.registry.list()
      if (!isOk(listed)) return fail("could not list harnesses")
      const harness = listed.value.find((h) => h.id === id)
      if (harness === undefined) return fail(`unknown harness: ${String(id)}`)

      const resolvedAlias = alias ?? harness.defaultAlias
      const proxyUrl = `http://${config.settings.proxyHost}:${config.settings.proxyPort}`

      // The GUI proxy runs persistently while the app is open; the launcher still needs *a* key.
      const launched = ctx.launch({
        harness,
        proxyUrl,
        proxyKey: ctx.genProxyKey(),
        model: resolvedAlias,
      })
      if (!isOk(launched)) return fail("failed to launch harness")

      const session = ctx.sessions.create({
        harnessId: harness.id,
        alias: resolvedAlias,
      })
      if (!isOk(session)) return fail("failed to record session")
      return session.value
    },

    // ── Sessions & proxy ─────────────────────────────────────────────────────────────────
    getSessions: async (filter) => {
      // Build a SessionFilter from IPC params, handling exactOptionalPropertyTypes
      const sessionFilter =
        filter === undefined
          ? undefined
          : (Object.fromEntries(
              Object.entries(filter).filter(([, v]) => v !== undefined),
            ) as import("@launchkit/sessions").SessionFilter)
      const queried = ctx.sessions.query(sessionFilter)
      if (!isOk(queried)) return fail("could not query sessions")
      return [...queried.value]
    },

    getProxyStatus: async () => {
      const running = await ctx.proxy.isRunning(ctx.proxyBaseUrl)
      return { running, port: ctx.proxyPort }
    },
  }
}
