import { describe, expect, it } from "bun:test"
import type { AttachmentKind, AttachmentRef } from "@spectrum/agent-events"
import type { StoredEvent } from "@spectrum/agent-events"
import type { Config } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import { resolveHarnessLaunch } from "@spectrum/harnesses"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import { createFakeCommandResolver } from "@spectrum/proc"
import { createProviderRegistry, getDescriptor } from "@spectrum/providers"
import type { ProviderDescriptor } from "@spectrum/providers"
import type { UploadStore } from "@spectrum/runtime-core"
import type {
  HarnessId,
  ModelId,
  ModelRoute,
  Provider,
  ProviderId,
  Session,
  SessionId,
} from "@spectrum/types"
import { type Result, err, isOk, ok } from "@spectrum/utils"
import type { GuiContext } from "../../composition"
import type { ResetError } from "../reset-app"
import { createFakeUpdater } from "../updater/fake-updater"
import type { UpdaterAdapter } from "../updater/updater-adapter"
import { createIpcHandlers } from "./handlers"

// --- a fully in-memory AppContext fake -------------------------------------------------

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p_openai",
    name: "OpenAI",
    sdkProvider: "openai",
    config: { baseUrl: "https://api.openai.com/v1" },
    secrets: { apiKey: { ref: "kc_openai" } },
    models: ["gpt-4o"],
    ...over,
  }) as Provider

/** A registered plugin descriptor, for tests that exercise a `plugin:*` provider key. */
const pluginDescriptor = (key: string): ProviderDescriptor => ({
  ...getDescriptor("custom"),
  key: key as ProviderDescriptor["key"],
  label: "Acme",
})

const baseConfig = (
  providers: readonly Provider[],
  lastSelectedFolder = "",
  lastSelectedHarnessId = "",
  updateSettings: {
    updateChannel?: "stable" | "canary"
    dismissedUpdateVersion?: string | null
    dismissedUpdateHash?: string | null
  } = {},
): Config => ({
  ...defaultConfig(),
  providers: [...providers],
  settings: {
    ...defaultConfig().settings,
    proxyPort: 4000,
    proxyHost: "127.0.0.1",
    lastSelectedFolder,
    lastSelectedHarnessId,
    collapsedProjects: [],
    updateChannel: updateSettings.updateChannel ?? "stable",
    dismissedUpdateVersion: updateSettings.dismissedUpdateVersion ?? null,
    dismissedUpdateHash: updateSettings.dismissedUpdateHash ?? null,
  },
})

/** Build a fake AppContext, capturing every save + secret set so tests can assert behavior. */
const makeCtx = (
  over: {
    providers?: readonly Provider[]
    models?: readonly ModelRoute[]
    setResult?: Result<{ readonly ref: string }, { readonly kind: string }>
    proxyRunning?: boolean
    proxyPort?: number
    session?: Session
    launchOk?: boolean
    runnerOk?: boolean
    proxyKeyStored?: string | null
    pickFolderResult?: readonly string[]
    openExternalUrlResult?: boolean
    lastSelectedFolder?: string
    lastSelectedHarnessId?: string
    runEvents?: Result<
      readonly StoredEvent[],
      { readonly kind: "db-failed"; readonly detail: string }
    >
    nativeHarnessId?: string
    updater?: UpdaterAdapter
    updateChannel?: "stable" | "canary"
    dismissedUpdateVersion?: string | null
    dismissedUpdateHash?: string | null
    deleteSessionResult?: Result<
      void,
      { readonly kind: "db-failed"; readonly detail: string }
    >
    deleteProjectResult?: Result<
      void,
      { readonly kind: "db-failed"; readonly detail: string }
    >
    resetAppResult?: Result<void, ResetError>
    log?: Logger
    resolverPathTable?: Record<string, string>
    renameSessionResult?: Result<
      Session,
      | { readonly kind: "not-found" }
      | { readonly kind: "invalid-name" }
      | { readonly kind: "db-failed"; readonly detail: string }
    >
    markUserNamedCalls?: SessionId[]
    draftListResult?: Result<
      readonly string[],
      { readonly kind: string; readonly detail?: string }
    >
    draftTestResult?: Result<
      { readonly ok: boolean; readonly latencyMs: number },
      { readonly kind: string; readonly detail?: string }
    >
    mintSessionProxyKey?: (modelId: string) => Promise<string>
    updateSocketUrl?: string
    pushUpdateState?: () => Promise<void>
    /**
     * Async hook the handler awaits before `ctx.runner.launch(...)`. When provided,
     * tests use `order.push(...)` to assert this resolves before the launch fires.
     * Defaults to a no-op so existing tests keep their original behavior.
     */
    ensureGuiPathResolved?: () => Promise<void>
    pickFilesResult?: readonly string[]
    uploadStore?: UploadStore
    providerRegistry?: GuiContext["providerRegistry"]
  } = {},
): {
  ctx: GuiContext
  saves: Config[]
  secretSets: string[]
  launchParams: unknown[]
  sessionInputs: unknown[]
  pickFolderCalls: unknown[]
  openExternalUrlCalls: unknown[]
  runnerLaunchInputs: unknown[]
  runEventsIds: string[]
  deletedSessionIds: string[]
  deletedProjectIds: string[]
  resetCalls: number
  draftTestInputs: unknown[]
  draftListInputs: unknown[]
  renameSessionCalls: { id: SessionId; name: string }[]
  markUserNamedCalls: SessionId[]
  pickFilesCalls: number
  uploadSaveInputs: Array<{
    sourcePath: string
    mime: string
    displayName: string
    maxBytes: number
  }>
  uploadSaveBytesInputs: Array<{
    data: Uint8Array
    mime: string
    displayName: string
    maxBytes: number
  }>
} => {
  const saves: Config[] = []
  const secretSets: string[] = []
  const launchParams: unknown[] = []
  const sessionInputs: unknown[] = []
  const pickFolderCalls: unknown[] = []
  const openExternalUrlCalls: unknown[] = []
  const runnerLaunchInputs: unknown[] = []
  const runEventsIds: string[] = []
  const deletedSessionIds: string[] = []
  const deletedProjectIds: string[] = []
  const draftTestInputs: unknown[] = []
  const draftListInputs: unknown[] = []
  const renameSessionCalls: { id: SessionId; name: string }[] = []
  const markUserNamedCalls: SessionId[] = []
  const resetState = { count: 0 }
  const pickFilesCallsArr: number[] = []
  const uploadSaveInputs: Array<{
    sourcePath: string
    mime: string
    displayName: string
    maxBytes: number
  }> = []
  const uploadSaveBytesInputs: Array<{
    data: Uint8Array
    mime: string
    displayName: string
    maxBytes: number
  }> = []
  /**
   * A recording fake UploadStore whose `save` mints a deterministic ref and
   * whose other methods default to "missing" so a test that only cares about
   * `save` does not need to stub them. Tests that exercise `readBase64` /
   * `pathOf` / `exists` override `over.uploadStore`.
   */
  const defaultUploadStore = (): UploadStore => ({
    save: async (params) => {
      uploadSaveInputs.push(params)
      const ref: AttachmentRef = {
        id: `sha_${params.displayName}`,
        mime: params.mime,
        displayName: params.displayName,
        kind: mimeToKind(params.mime),
        bytes: 0,
      }
      return ok({ ref, path: `/tmp/uploads/${ref.id}` })
    },
    saveBytes: async (params) => {
      uploadSaveBytesInputs.push(params)
      const ref: AttachmentRef = {
        id: `sha_${params.displayName}`,
        mime: params.mime,
        displayName: params.displayName,
        kind: mimeToKind(params.mime),
        bytes: params.data.byteLength,
      }
      return ok({ ref, path: `/tmp/uploads/${ref.id}` })
    },
    readBase64: async () => err({ kind: "not-found", detail: "stub" }),
    pathOf: async () => err({ kind: "not-found", detail: "stub" }),
    exists: async () => false,
    size: async () => 0,
  })
  let current: Config = {
    ...baseConfig(
      over.providers ?? [provider()],
      over.lastSelectedFolder ?? "",
      over.lastSelectedHarnessId ?? "",
      {
        ...(over.updateChannel !== undefined
          ? { updateChannel: over.updateChannel }
          : {}),
        ...(over.dismissedUpdateVersion !== undefined
          ? { dismissedUpdateVersion: over.dismissedUpdateVersion }
          : {}),
        ...(over.dismissedUpdateHash !== undefined
          ? { dismissedUpdateHash: over.dismissedUpdateHash }
          : {}),
      },
    ),
    ...(over.models !== undefined ? { models: [...over.models] } : {}),
  }

  // The handler resolves the harness command+env via ctx.resolveLaunch — use the REAL renderer
  // over a fake resolver so the rendered proxy vars (ANTHROPIC_*) are asserted faithfully.
  // `over.resolverPathTable` lets a test inject an empty/invalid table to drive resolve failure.
  const resolveLaunch = resolveHarnessLaunch({
    resolver: createFakeCommandResolver(
      over.resolverPathTable ?? { claude: "/usr/local/bin/claude" },
    ),
  })

  const ctx = {
    log: over.log ?? createNoopLogger(),
    // The test stub narrows the error type to a "always-ok" shape (it cannot
    // fail). The real `ConfigStore` widens it to `ConfigError`; cast on the
    // *whole* object at the end of the literal matches the real signature.
    config: {
      load: async (): Promise<Result<Config, never>> => ok(current),
      save: async (next: Config): Promise<Result<void, never>> => {
        saves.push(next)
        current = next
        return ok(undefined)
      },
    },
    secrets: {
      set: async (value: string) => {
        secretSets.push(value)
        return over.setResult ?? ok({ ref: "kc_new" })
      },
      get: async () => ok("sk-never-leaves"),
      delete: async () => ok(undefined),
      has: async () => true,
    },
    sessions: {
      init: () => ok(undefined),
      create: (input: unknown) => {
        sessionInputs.push(input)
        return over.session !== undefined ? ok(over.session) : ok(sampleSession)
      },
      close: () => ok(sampleSession),
      query: () => ok([sampleSession]),
      updateName: (id: SessionId, name: string) => {
        renameSessionCalls.push({ id, name })
        return over.renameSessionResult ?? ok({ ...sampleSession, name })
      },
      reconcileOrphaned: () => ok(0),
    },
    launch: (params: unknown) => {
      launchParams.push(params)
      return over.launchOk === false
        ? err({ kind: "spawn-failed", detail: "ENOENT" })
        : ok({ pid: 4321, exited: Promise.resolve(0) })
    },
    proxy: {
      isRunning: async () => over.proxyRunning ?? true,
      start: () => ({
        hostname: "127.0.0.1",
        port: over.proxyPort ?? 4000,
        stop: () => {},
      }),
    },
    proxyPort: over.proxyPort ?? 4000,
    proxyBaseUrl: `http://127.0.0.1:${over.proxyPort ?? 4000}`,
    testProvider: async () => ok({ ok: true, latencyMs: 12 }),
    testProviderDraft: async (input: unknown) => {
      draftTestInputs.push(input)
      return over.draftTestResult ?? ok({ ok: true, latencyMs: 7 })
    },
    listProviderModelsDraft: async (input: unknown) => {
      draftListInputs.push(input)
      return (
        over.draftListResult ?? ok([{ id: "gpt-4o" }, { id: "gpt-4o-mini" }])
      )
    },
    runtime: {
      readProxyKey: async () => over.proxyKeyStored ?? null,
      writeProxyKey: async () => ok(undefined),
      clear: async () => undefined,
    },
    resolveLaunch,
    registry: {
      list: async () =>
        ok([
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {
              ANTHROPIC_BASE_URL: "{{proxyUrl}}",
              ANTHROPIC_API_KEY: "{{proxyKey}}",
              ANTHROPIC_MODEL: "{{model}}",
            },
            builtIn: true,
          },
        ]),
    },
    genProxyKey: () => "test-key",
    mintSessionProxyKey:
      over.mintSessionProxyKey ??
      (async (m: string) => `master.${Buffer.from(m).toString("base64url")}`),
    factory: {},
    gateway: {},
    paths: {
      configFile: "/tmp/config.json",
      dbFile: "/tmp/spectrum.db",
      harnessDir: "/tmp/harnesses",
    },
    pickFolder: async (opts: unknown) => {
      pickFolderCalls.push(opts)
      return over.pickFolderResult ?? []
    },
    openExternalUrl: async (url: unknown) => {
      openExternalUrlCalls.push(url)
      return over.openExternalUrlResult ?? true
    },
    runner: {
      launch: (input: unknown) => {
        runnerLaunchInputs.push(input)
        return over.runnerOk === false
          ? err({ kind: "start-failed", detail: "no driver" })
          : ok({ sessionId: sampleSession.id })
      },
      handleInbound: () => undefined,
      bindSend: () => undefined,
      markUserNamed: (id: SessionId) => {
        markUserNamedCalls.push(id)
      },
    },
    runnerSocketUrl: "ws://localhost:23456/",
    updateSocketUrl: over.updateSocketUrl ?? "ws://localhost:0/",
    pushUpdateState: over.pushUpdateState ?? (async () => {}),
    runEvents: {
      read: (id: unknown) => {
        runEventsIds.push(id as string)
        return (
          over.runEvents ??
          ok([
            {
              seq: 0,
              sessionId: sampleSession.id,
              ts: "2026-06-08T12:00:00.000Z",
              event: { type: "runner-started", runnerId: "r_root" },
            },
          ])
        )
      },
    },
    driverRegistry: {
      get: () => undefined,
      isNative: (harnessId: unknown) =>
        String(harnessId) === (over.nativeHarnessId ?? "claude"),
    },
    updater: over.updater ?? createFakeUpdater({ currentVersion: "1.0.0" }),
    dataAdmin: {
      deleteSession: (id: unknown) => {
        deletedSessionIds.push(id as string)
        return over.deleteSessionResult ?? ok(undefined)
      },
      deleteProject: (id: unknown) => {
        deletedProjectIds.push(id as string)
        return over.deleteProjectResult ?? ok(undefined)
      },
    },
    resetApp: async () => {
      resetState.count += 1
      return over.resetAppResult ?? ok(undefined)
    },
    // Default to a no-op so existing tests keep their original behavior; the
    // PATH-resolved order test overrides this with an order-recording stub.
    ensureGuiPathResolved: over.ensureGuiPathResolved ?? (async () => {}),
    pickFiles: async () => {
      pickFilesCallsArr.push(1)
      return over.pickFilesResult ?? []
    },
    uploadStore: over.uploadStore ?? defaultUploadStore(),
    // Real (builtins-only) registry — the four inline `createProviderRegistry()` calls this
    // task removed from handlers.ts now read `ctx.providerRegistry`, so the fake context needs
    // a real one for `validateProviderConfig` to resolve descriptors.
    providerRegistry: over.providerRegistry ?? createProviderRegistry(),
  } as unknown as GuiContext

  return {
    ctx,
    saves,
    secretSets,
    launchParams,
    sessionInputs,
    pickFolderCalls,
    openExternalUrlCalls,
    runnerLaunchInputs,
    runEventsIds,
    deletedSessionIds,
    deletedProjectIds,
    get resetCalls() {
      return resetState.count
    },
    draftTestInputs,
    draftListInputs,
    renameSessionCalls,
    markUserNamedCalls,
    get pickFilesCalls() {
      return pickFilesCallsArr.length
    },
    uploadSaveInputs,
    uploadSaveBytesInputs,
  }
}

const mimeToKind = (mime: string): AttachmentKind => {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("text/")) return "text"
  return "binary"
}

/**
 * Extract the `value` from a `Result` whose `Ok` branch is statically known to
 * hold (test stubs only). Mirrors `unwrapOr(r, throw)` without leaking `throw`
 * out of the helper — keeps tests readable when chaining.
 */
const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!isOk(r)) throw new Error("test stub produced Err")
  return r.value
}

const sampleSession: Session = {
  id: "s_1",
  harnessId: "claude",
  modelId: "mdl_default",
  startedAt: "2026-05-23T10:00:00.000Z",
} as Session

// --- tests -----------------------------------------------------------------------------

describe("createIpcHandlers.getProviders", () => {
  it("projects each Provider to a ProviderView with presence-only secret fields when listing", async () => {
    const { ctx } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    const views = await handlers.getProviders(undefined)

    expect(views).toEqual([
      {
        id: "p_openai" as ProviderId,
        name: "OpenAI",
        sdkProvider: "openai",
        config: { baseUrl: "https://api.openai.com/v1" },
        secretFields: { apiKey: { isSet: true } },
        models: ["gpt-4o"],
      },
    ])
  })

  it("never emits a secret ref or value in the ProviderView when listing", async () => {
    const { ctx } = makeCtx({
      providers: [provider({ secrets: { apiKey: { ref: "kc_secret_ref" } } })],
    })
    const handlers = createIpcHandlers(ctx)

    const serialized = JSON.stringify(await handlers.getProviders(undefined))

    expect(serialized).not.toContain("kc_secret_ref")
    expect(serialized).not.toContain('"ref"')
    expect(serialized).not.toContain("sk-")
  })

  it("marks a secret field isSet:true for every keychain ref the provider holds", async () => {
    const { ctx } = makeCtx({
      providers: [
        provider({
          secrets: {
            apiKey: { ref: "kc_a" },
            secretAccessKey: { ref: "kc_b" },
          },
        }),
      ],
    })
    const handlers = createIpcHandlers(ctx)

    const [view] = await handlers.getProviders(undefined)

    expect(view?.secretFields).toEqual({
      apiKey: { isSet: true },
      secretAccessKey: { isSet: true },
    })
  })
})

describe("createIpcHandlers.addProvider", () => {
  it("throws so the server surfaces handler-failed when the custom config has malformed headers", async () => {
    const { ctx } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.addProvider({
        sdkProvider: "custom",
        config: { headers: "not-json" },
        secretFieldNames: [],
        models: [],
      }),
    ).rejects.toThrow()
  })

  it("falls back to the sdkProvider name when no name is given", async () => {
    const { ctx, saves } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)

    const view = await handlers.addProvider({
      sdkProvider: "anthropic",
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })

    expect(view.name).toBe("anthropic")
    const savedProviders = saves.at(-1)?.providers ?? []
    expect(savedProviders.at(-1)?.name).toBe("anthropic")
  })

  it("falls back to the sdkProvider name when the name is blank/whitespace", async () => {
    const { ctx } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)

    const view = await handlers.addProvider({
      name: "   ",
      sdkProvider: "groq",
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })

    expect(view.name).toBe("groq")
  })

  it("keeps the provided name when one is given", async () => {
    const { ctx } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)

    const view = await handlers.addProvider({
      name: "My OpenAI",
      sdkProvider: "openai",
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })

    expect(view.name).toBe("My OpenAI")
  })

  it("writes each inline secret to the keychain and persists only the SecretRef", async () => {
    const { ctx, saves, secretSets } = makeCtx({
      providers: [],
      setResult: ok({ ref: "kc_minted" }),
    })
    const handlers = createIpcHandlers(ctx)

    const view = await handlers.addProvider({
      sdkProvider: "ollama",
      config: { serverUrl: "https://ollama.com/api" },
      secretFieldNames: ["apiKey"],
      secrets: { apiKey: "sk-live-secret" },
      models: ["qwen2.5-coder"],
    })

    expect(secretSets).toEqual(["sk-live-secret"])
    const saved = saves.at(-1)?.providers.at(-1)
    expect(saved?.secrets).toEqual({ apiKey: { ref: "kc_minted" } })
    expect(saved?.models).toEqual(["qwen2.5-coder"])
    // The view masks secrets to presence flags — never a ref or value.
    expect(view.secretFields).toEqual({ apiKey: { isSet: true } })
  })

  it("creates a keyless provider when secrets is omitted", async () => {
    const { ctx, saves, secretSets } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)
    await handlers.addProvider({
      sdkProvider: "openai",
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })
    expect(secretSets).toEqual([])
    expect(saves.at(-1)?.providers.at(-1)?.secrets).toEqual({})
  })

  it("throws and persists nothing when storing a secret fails", async () => {
    const { ctx, saves, secretSets } = makeCtx({
      providers: [],
      setResult: err({ kind: "backend-failed" }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.addProvider({
        sdkProvider: "ollama",
        config: {},
        secretFieldNames: ["apiKey"],
        secrets: { apiKey: "sk-x" },
        models: [],
      }),
    ).rejects.toThrow()
    // keychain write was attempted, but no provider was saved (abort before save)
    expect(secretSets).toEqual(["sk-x"])
    expect(saves).toHaveLength(0)
  })

  it("ignores inline secrets for fields the provider does not declare", async () => {
    const { ctx, secretSets, saves } = makeCtx({
      providers: [],
      setResult: ok({ ref: "kc_x" }),
    })
    const handlers = createIpcHandlers(ctx)
    await handlers.addProvider({
      sdkProvider: "ollama",
      config: {},
      secretFieldNames: ["apiKey"],
      secrets: { apiKey: "keep", bogus: "drop" },
      models: [],
    })
    expect(secretSets).toEqual(["keep"])
    expect(saves.at(-1)?.providers.at(-1)?.secrets).toEqual({
      apiKey: { ref: "kc_x" },
    })
  })
})

describe("createIpcHandlers.updateProvider", () => {
  it("falls back to the sdkProvider name when updating with a blank name", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    const view = await handlers.updateProvider({
      id: provider().id,
      input: {
        name: "   ",
        sdkProvider: "anthropic",
        config: {},
        secretFieldNames: ["apiKey"],
        models: [],
      },
    })

    expect(view.name).toBe("anthropic")
    const savedProviders = saves.at(-1)?.providers ?? []
    expect(savedProviders.at(-1)?.name).toBe("anthropic")
  })

  it("throws so the server surfaces handler-failed when the custom config has malformed headers", async () => {
    const { ctx } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.updateProvider({
        id: provider().id,
        input: {
          sdkProvider: "custom",
          config: { headers: "not-json" },
          secretFieldNames: [],
          models: [],
        },
      }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers.setProviderSecret", () => {
  it("stores the raw value in the keychain and saves the returned ref onto the provider", async () => {
    const { ctx, saves, secretSets } = makeCtx({
      providers: [provider({ secrets: {} })],
      setResult: ok({ ref: "kc_minted" }),
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.setProviderSecret({
      providerId: "p_openai" as never,
      field: "apiKey",
      value: "sk-live-secret",
    })

    // void result encoded as null
    expect(result).toBeNull()
    // the raw value went to the keychain ...
    expect(secretSets).toEqual(["sk-live-secret"])
    // ... and only the ref (never the value) is persisted on the provider
    expect(saves).toHaveLength(1)
    const saved = saves[0]?.providers.find(
      (p) => p.id === ("p_openai" as never),
    )
    expect(saved?.secrets).toEqual({ apiKey: { ref: "kc_minted" } })
  })

  it("throws so the server surfaces handler-failed when the keychain set fails", async () => {
    const { ctx } = makeCtx({
      providers: [provider({ secrets: {} })],
      setResult: err({ kind: "backend-failed" }),
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.setProviderSecret({
        providerId: "p_openai" as never,
        field: "apiKey",
        value: "sk-x",
      }),
    ).rejects.toThrow()
  })

  it("throws when setProviderSecret targets a provider id that does not exist", async () => {
    const { ctx } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.setProviderSecret({
        providerId: "p_ghost" as never,
        field: "apiKey",
        value: "sk-x",
      }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers models CRUD", () => {
  it("getModels returns the routes from the loaded config when listing", async () => {
    const { ctx } = makeCtx()
    const route = {
      id: "mdl_a" as ModelId,
      providerId: "p_openai" as ProviderId,
      providerModel: "gpt-4o",
      aliases: [] as string[],
      attachments: {},
    }
    await ctx.config.save({
      ...unwrap(await ctx.config.load()),
      models: [route],
    } as Config)
    const handlers = createIpcHandlers(ctx)

    expect(await handlers.getModels(undefined)).toEqual([route])
  })

  it("addModel mints an id and persists the model", async () => {
    const { ctx, saves } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const created = await handlers.addModel({
      providerId: "openai" as ProviderId,
      providerModel: "gpt-4o",
      aliases: [],
      attachments: {},
    })

    expect(created.providerModel).toBe("gpt-4o")
    expect(String(created.providerId)).toBe("openai")
    expect(String(created.id)).toMatch(/^mdl_/)
    expect(saves).toHaveLength(1)
    expect(saves[0]?.models).toEqual([created])
  })

  it("addModel persists the aliases passed in params", async () => {
    const { ctx, saves } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const created = await handlers.addModel({
      providerId: "p_anthropic" as ProviderId,
      providerModel: "claude-haiku-4-5",
      aliases: ["haiku", "fast"],
      attachments: {},
    })

    expect(created.aliases).toEqual(["haiku", "fast"])
    expect(saves[0]?.models.at(-1)?.aliases).toEqual(["haiku", "fast"])
  })

  it("updateModel replaces the matching route by id, preserving the id and persisting aliases", async () => {
    const { ctx, saves } = makeCtx()
    const route = {
      id: "mdl_a" as ModelId,
      providerId: "p_openai" as ProviderId,
      providerModel: "gpt-4o",
      aliases: [] as string[],
      attachments: {},
    }
    await ctx.config.save({
      ...unwrap(await ctx.config.load()),
      models: [route],
    } as Config)
    const handlers = createIpcHandlers(ctx)

    const updated = await handlers.updateModel({
      id: "mdl_a" as ModelId,
      input: {
        providerId: "p_anthropic" as ProviderId,
        providerModel: "opus",
        aliases: ["opus-fast"],
        attachments: {},
      },
    })

    expect(updated).toEqual({
      id: "mdl_a" as ModelId,
      providerId: "p_anthropic" as ProviderId,
      providerModel: "opus",
      aliases: ["opus-fast"],
      attachments: {},
    })
    expect(saves.at(-1)?.models).toEqual([updated])
  })

  it("addModel stamps heuristic capabilities with source auto when omitted", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    const created = await handlers.addModel({
      providerId: "p_openai" as ProviderId,
      providerModel: "gpt-4o",
      aliases: [],
    })
    expect(created.attachments.image).toBe(true)
    expect(created.attachmentsSource).toBe("auto")
  })

  it("addModel persists caller-supplied capabilities verbatim with source user", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    const created = await handlers.addModel({
      providerId: "p_openai" as ProviderId,
      providerModel: "totally-unknown-model",
      aliases: [],
      attachments: { image: true, pdf: false },
      attachmentsSource: "user",
    })
    expect(created.attachments).toEqual({ image: true, pdf: false })
    expect(created.attachmentsSource).toBe("user")
  })

  it("updateModel preserves existing capabilities when omitted", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    const created = await handlers.addModel({
      providerId: "p_openai" as ProviderId,
      providerModel: "x",
      aliases: [],
      attachments: { image: true },
      attachmentsSource: "user",
    })
    const updated = await handlers.updateModel({
      id: created.id,
      input: {
        providerId: created.providerId,
        providerModel: "x-renamed",
        aliases: [],
        attachments: {},
      },
    })
    expect(updated.attachments).toEqual({ image: true })
    expect(updated.attachmentsSource).toBe("user")
  })

  it("deleteModel removes the route and returns null", async () => {
    const { ctx, saves } = makeCtx()
    const route = {
      id: "mdl_a" as ModelId,
      providerId: "p_openai" as ProviderId,
      providerModel: "gpt-4o",
    }
    await ctx.config.save({
      ...unwrap(await ctx.config.load()),
      models: [route],
    } as Config)
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.deleteModel({ id: "mdl_a" as ModelId })

    expect(result).toBeNull()
    expect(saves.at(-1)?.models).toEqual([])
  })
})

describe("createIpcHandlers.launchHarness", () => {
  it("with a modelId resolves a proxied launch and threads the modelId to the runner", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      proxyKeyStored: "stored-run-key",
      proxyPort: 4000,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_x" as ModelId,
    })

    // The run manager owns session creation; the handler returns only the sessionId.
    expect(result).toEqual({ sessionId: sampleSession.id })
    expect(runnerLaunchInputs).toHaveLength(1)
    const input = runnerLaunchInputs[0] as {
      harnessId: string
      modelId?: string
      command: string
      env: Record<string, string>
    }
    expect(input.harnessId).toBe("claude")
    // The session is stored against the routed modelId (no alias anymore).
    expect(input.modelId).toBe("mdl_x")
    expect(input.command).toBe("/usr/local/bin/claude")
    // The rendered proxy vars carry the loopback proxy URL + session-encoded proxy key + modelId.
    expect(input.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000")
    // Key is now a session-encoded token: <masterKey>.<base64url(modelId)> from mintSessionProxyKey.
    expect(input.env.ANTHROPIC_API_KEY).toBe(
      `master.${Buffer.from("mdl_x").toString("base64url")}`,
    )
    expect(input.env.ANTHROPIC_MODEL).toBe("mdl_x")
  })

  it("without a modelId launches direct (bypass) with no proxy env and no modelId on the session", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      proxyKeyStored: "stored-run-key",
      proxyPort: 4000,
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId })

    const input = runnerLaunchInputs[0] as Record<string, unknown> & {
      env: Record<string, string>
    }
    // Bypass: the runner must not carry a modelId ...
    expect("modelId" in input).toBe(false)
    // ... and the direct route renders NO proxy env (the harness uses native creds).
    expect("ANTHROPIC_BASE_URL" in input.env).toBe(false)
    expect("ANTHROPIC_API_KEY" in input.env).toBe(false)
    expect("ANTHROPIC_MODEL" in input.env).toBe(false)
  })

  it("does NOT create a duplicate session directly — the run manager owns it", async () => {
    const { ctx, sessionInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_x" as ModelId,
    })

    expect(sessionInputs).toEqual([])
  })

  it("falls back to a freshly minted proxy key when none is stored (routed launch)", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      proxyKeyStored: null,
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_x" as ModelId,
    })

    const input = runnerLaunchInputs[0] as { env: Record<string, string> }
    // Key is now a session-encoded token from mintSessionProxyKey; when no key is stored the
    // default fake uses "master" as the prefix: master.<base64url(modelId)>.
    expect(input.env.ANTHROPIC_API_KEY).toBe(
      `master.${Buffer.from("mdl_x").toString("base64url")}`,
    )
  })

  it("throws so the server surfaces handler-failed when the harness has no native driver", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      nativeHarnessId: "__none__",
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId }),
    ).rejects.toThrow()
    expect(runnerLaunchInputs).toHaveLength(0)
  })

  it("throws so the server surfaces handler-failed when runner.launch errors", async () => {
    const { ctx } = makeCtx({ providers: [provider()], runnerOk: false })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId }),
    ).rejects.toThrow()
  })

  it("persists the launched cwd as settings.lastSelectedFolder on a successful launch", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      name: "x",
      cwd: "/home/me/proj",
      env: {},
    })

    expect(saves.at(-1)?.settings.lastSelectedFolder).toBe("/home/me/proj")
  })

  it("keeps the prior lastSelectedFolder when cwd is blank but still persists harness", async () => {
    const { ctx, saves } = makeCtx({
      providers: [provider()],
      lastSelectedFolder: "/home/me/prior",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_1" as ModelId,
      name: "x",
      cwd: "   ",
      env: {},
    })

    // A save STILL happens — harness persists on every success ...
    const saved = saves.at(-1)
    expect(saved?.settings.lastSelectedHarnessId).toBe("claude")
    // ... but the folder is unchanged (blank cwd never overwrites the prior value).
    expect(saved?.settings.lastSelectedFolder).toBe("/home/me/prior")
  })

  it("persists the launched harness on a successful launch (no model field on save)", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_1" as ModelId,
      env: {},
    })

    const saved = saves.at(-1)
    expect(saved?.settings.lastSelectedHarnessId).toBe("claude")
    // The legacy lastSelectedModelId is gone — model lives in lastByHarness.
    expect(
      "lastSelectedModelId" in (saved?.settings as Record<string, unknown>),
    ).toBe(false)
  })

  it("persists harness on a default (no-model) launch", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const saved = saves.at(-1)
    expect(saved?.settings.lastSelectedHarnessId).toBe("claude")
    expect(
      "lastSelectedModelId" in (saved?.settings as Record<string, unknown>),
    ).toBe(false)
  })

  it("persists harness even when no cwd is provided", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    expect(saves.at(-1)).toBeDefined()
    expect(saves.at(-1)?.settings.lastSelectedHarnessId).toBe("claude")
  })

  it("does not persist harness when the launch fails", async () => {
    const { ctx, saves } = makeCtx({
      providers: [provider()],
      runnerOk: false,
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId, env: {} }),
    ).rejects.toThrow()

    expect(saves).toHaveLength(0)
  })

  it("does not persist lastSelectedFolder when the launch fails", async () => {
    const { ctx, saves } = makeCtx({
      providers: [provider()],
      runnerOk: false,
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({
        id: "claude" as HarnessId,
        name: "x",
        cwd: "/home/me/proj",
        env: {},
      }),
    ).rejects.toThrow()

    expect(saves).toHaveLength(0)
  })

  it("throws with the resolve-failure cause in the message when harness command is not found", async () => {
    const { ctx } = makeCtx({ resolverPathTable: {} })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "failed to resolve harness launch",
        ) as string,
      }),
    )
    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "command not found on PATH: claude",
        ) as string,
      }),
    )
  })

  it("logs the resolve-failure cause to the ipc-scoped error log when harness command is not found", async () => {
    const ipcErrors: string[] = []
    const recordingChild: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => {
        ipcErrors.push(msg)
      },
      fatal: () => {},
      child: () => recordingChild,
    }
    const recordingLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: (scope: string) =>
        scope === "ipc" ? recordingChild : recordingLog,
    }

    const { ctx } = makeCtx({ resolverPathTable: {}, log: recordingLog })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.launchHarness({ id: "claude" as HarnessId }),
    ).rejects.toThrow()

    expect(
      ipcErrors.some((m) => m.includes("command not found on PATH: claude")),
    ).toBe(true)
  })
})

describe("createIpcHandlers.launchHarness session-encoded proxy key", () => {
  it("renders the harness env from a session-encoded proxy key", async () => {
    const minted: string[] = []
    const ctx = makeCtx({
      // config has one model so the launch is proxied
      models: [
        {
          id: "mdl_sel" as ModelId,
          providerId: "p1" as ProviderId,
          providerModel: "claude-opus",
          aliases: [],
          attachments: {},
        } satisfies ModelRoute,
      ],
      mintSessionProxyKey: async (modelId: string) => {
        minted.push(modelId)
        return `master.${Buffer.from(modelId).toString("base64url")}`
      },
    }).ctx
    const handlers = createIpcHandlers(ctx)
    const r = await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_sel" as ModelId,
      cwd: "/tmp",
    })
    expect(r).toHaveProperty("sessionId")
    expect(minted).toEqual(["mdl_sel"])
  })
})

describe("createIpcHandlers.launchHarness effective proxy port", () => {
  it("uses the effective (channel-offset) proxy port in the launch proxy URL", async () => {
    // ctx.proxyPort = 4001 (canary offset); the handler must build proxyUrl from ctx.proxyPort
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      proxyKeyStored: "stored-run-key",
      proxyPort: 4001,
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_x" as ModelId,
    })

    const input = runnerLaunchInputs[0] as { env: Record<string, string> }
    expect(input.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4001")
  })
})

describe("createIpcHandlers.launchHarness wire alias", () => {
  it("hands the CLI a claude-spectrum wire name when the routed model can take images", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      models: [
        {
          id: "mdl_vision" as ModelId,
          providerId: "p_openai" as ProviderId,
          providerModel: "llava:13b",
          aliases: [] as string[],
          attachments: { image: true },
          attachmentsSource: "user" as const,
        } satisfies ModelRoute,
      ],
      proxyKeyStored: "stored-run-key",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_vision" as ModelId,
    })

    const input = runnerLaunchInputs[0] as { env: Record<string, string> }
    expect(input.env.ANTHROPIC_MODEL).toBe("claude-spectrum-mdl_vision")
  })

  it("falls back to the raw model id when the routed model has no attachment capabilities", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      models: [
        {
          id: "mdl_text" as ModelId,
          providerId: "p_openai" as ProviderId,
          providerModel: "kimi-k2.7-code",
          aliases: [] as string[],
          attachments: {},
        } satisfies ModelRoute,
      ],
      proxyKeyStored: "stored-run-key",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_text" as ModelId,
    })

    const input = runnerLaunchInputs[0] as { env: Record<string, string> }
    expect(input.env.ANTHROPIC_MODEL).toBe("mdl_text")
  })
})

describe("createIpcHandlers.getHarnesses", () => {
  it("getHarnesses sets native from the driver registry", async () => {
    const { ctx } = makeCtx({ nativeHarnessId: "claude" })
    const handlers = createIpcHandlers(ctx)
    const harnesses = await handlers.getHarnesses(undefined)
    expect(harnesses.find((h) => h.id === "claude")?.native).toBe(true)
  })

  it("getHarnesses sets native=false for harnesses with no registered driver", async () => {
    const { ctx } = makeCtx({ nativeHarnessId: "__none__" })
    const handlers = createIpcHandlers(ctx)
    const harnesses = await handlers.getHarnesses(undefined)
    expect(harnesses.every((h) => h.native === false)).toBe(true)
  })
})

describe("createIpcHandlers.getProxyStatus", () => {
  it("reports running:true and the bound port when the proxy is up", async () => {
    const { ctx } = makeCtx({ proxyRunning: true, proxyPort: 4000 })
    const handlers = createIpcHandlers(ctx)

    expect(await handlers.getProxyStatus(undefined)).toEqual({
      running: true,
      port: 4000,
    })
  })

  it("reports running:false when the proxy is not up", async () => {
    const { ctx } = makeCtx({ proxyRunning: false, proxyPort: 4000 })
    const handlers = createIpcHandlers(ctx)

    expect(await handlers.getProxyStatus(undefined)).toEqual({
      running: false,
      port: 4000,
    })
  })
})

describe("createIpcHandlers.getSettings", () => {
  it("returns the persisted fields from the loaded config (no lastSelectedModelId)", async () => {
    const { ctx } = makeCtx({
      lastSelectedFolder: "/home/me/last",
      lastSelectedHarnessId: "claude",
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getSettings(undefined)
    expect(result.lastSelectedFolder).toBe("/home/me/last")
    expect(result.lastSelectedHarnessId).toBe("claude")
    expect(result.collapsedProjects).toEqual([])
  })

  it("returns empty strings when nothing has been persisted", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getSettings(undefined)
    expect(result.lastSelectedFolder).toBe("")
    expect(result.lastSelectedHarnessId).toBe("")
    expect(result.collapsedProjects).toEqual([])
  })
})

// ── D.2 pickFolder ─────────────────────────────────────────────────────────────

describe("createIpcHandlers.pickFolder", () => {
  it("returns the first selected path when the dialog resolves a folder", async () => {
    const { ctx, pickFolderCalls } = makeCtx({
      pickFolderResult: ["/Users/me/project"],
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.pickFolder({ startingFolder: "/Users/me" })

    expect(result).toEqual({ path: "/Users/me/project" })
    expect(pickFolderCalls).toEqual([{ startingFolder: "/Users/me" }])
  })

  it("returns an empty object when the dialog is cancelled (no selection)", async () => {
    const { ctx } = makeCtx({ pickFolderResult: [] })
    const handlers = createIpcHandlers(ctx)
    expect(await handlers.pickFolder({})).toEqual({})
  })

  it("returns an empty object when params are undefined", async () => {
    const { ctx } = makeCtx({ pickFolderResult: [] })
    const handlers = createIpcHandlers(ctx)
    expect(await handlers.pickFolder(undefined)).toEqual({})
  })
})

// ── D.3 openExternalUrl ───────────────────────────────────────────────────────

describe("createIpcHandlers.openExternalUrl", () => {
  it("delegates the url to ctx.openExternalUrl and returns null on success", async () => {
    const { ctx, openExternalUrlCalls } = makeCtx({
      openExternalUrlResult: true,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.openExternalUrl({
      url: "https://example.com",
    })

    expect(result).toBeNull()
    expect(openExternalUrlCalls).toEqual(["https://example.com"])
  })

  it("fails the handler when the OS reports it did not open the url", async () => {
    const { ctx } = makeCtx({ openExternalUrlResult: false })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.openExternalUrl({ url: "https://example.com" }),
    ).rejects.toThrow()
  })
})

// ── D.5 launchHarness session metadata + getSessions pagination ───────────────

describe("createIpcHandlers.launchHarness (session metadata)", () => {
  it("threads name, cwd, and extra env into runner.launch", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as never,
      modelId: "mdl_x" as ModelId,
      name: "refactor run",
      cwd: "/work/repo",
      env: { EXTRA: "1" },
    })

    const input = runnerLaunchInputs[0] as {
      name?: string
      cwd?: string
      env: Record<string, string>
    }
    expect(input.name).toBe("refactor run")
    expect(input.cwd).toBe("/work/repo")
    expect(input.env.EXTRA).toBe("1")
    // Routed launch (modelId present) renders the proxy env.
    expect(input.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000")
  })

  it("omits name when not supplied (exactOptionalPropertyTypes safe)", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as never })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("name" in input).toBe(false)
    // The runner always receives a cwd (defaulting to "" when none was given).
    expect(input.cwd).toBe("")
  })

  it("coerces empty/blank name and cwd to omitted (never creates a session named '')", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as never,
      name: "",
      cwd: "   ",
    })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("name" in input).toBe(false)
    // A blank cwd is coerced to "" (never a whitespace path).
    expect(input.cwd).toBe("")
  })
})

// ── D.6 listProviderModels ────────────────────────────────────────────────────

describe("createIpcHandlers.listProviderModels", () => {
  it("returns { models } when ctx.listProviderModels resolves ok", async () => {
    const { ctx } = makeCtx()
    ;(ctx as { listProviderModels: unknown }).listProviderModels = async () =>
      ok([{ id: "gpt-4o" }, { id: "gpt-4o-mini" }])
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.listProviderModels({
      providerId: "p_openai" as never,
    })

    expect(result).toEqual({
      models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    })
  })

  it("throws so the server surfaces handler-failed when ctx.listProviderModels returns err", async () => {
    const { ctx } = makeCtx()
    ;(ctx as { listProviderModels: unknown }).listProviderModels = async () =>
      err({ kind: "unknown-provider", providerId: "p_ghost" })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.listProviderModels({ providerId: "p_ghost" as never }),
    ).rejects.toThrow()
  })

  it("passes the providerId string to ctx.listProviderModels", async () => {
    const calls: string[] = []
    const { ctx } = makeCtx()
    ;(ctx as { listProviderModels: unknown }).listProviderModels = async (
      id: string,
    ) => {
      calls.push(id)
      return ok(["llama3"])
    }
    const handlers = createIpcHandlers(ctx)

    await handlers.listProviderModels({ providerId: "p_ollama" as never })

    expect(calls).toEqual(["p_ollama"])
  })
})

describe("createIpcHandlers.getSessions (running + pagination)", () => {
  it("passes running, limit, and offset through to sessions.query", async () => {
    const queries: unknown[] = []
    const { ctx } = makeCtx()
    ;(ctx.sessions as { query: unknown }).query = (filter: unknown) => {
      queries.push(filter)
      return ok([sampleSession])
    }
    const handlers = createIpcHandlers(ctx)

    await handlers.getSessions({ running: true, limit: 20, offset: 40 })

    expect(queries[0]).toEqual({ running: true, limit: 20, offset: 40 })
  })

  it("drops undefined keys from the filter", async () => {
    const queries: unknown[] = []
    const { ctx } = makeCtx()
    ;(ctx.sessions as { query: unknown }).query = (filter: unknown) => {
      queries.push(filter)
      return ok([])
    }
    const handlers = createIpcHandlers(ctx)

    await handlers.getSessions({ running: undefined })

    expect(queries[0]).toEqual({})
  })
})

describe("createIpcHandlers.getRunnerSocketUrl", () => {
  it("returns the runner socket url from the context", async () => {
    const { ctx } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)
    const result = await handlers.getRunnerSocketUrl(undefined)
    expect(result).toEqual({ url: "ws://localhost:23456/" })
  })
})

describe("createIpcHandlers.getUpdateSocketUrl", () => {
  it("returns the update socket url from the context", async () => {
    const { ctx } = makeCtx({ updateSocketUrl: "ws://localhost:9999/" })
    const handlers = createIpcHandlers(ctx)
    const result = await handlers.getUpdateSocketUrl(undefined)
    expect(result).toEqual({ url: "ws://localhost:9999/" })
  })
})

describe("createIpcHandlers push-on-check", () => {
  it("checkForUpdate pushes the built state via pushUpdateState", async () => {
    const pushed: unknown[] = []
    const { ctx } = makeCtx({
      pushUpdateState: async () => {
        pushed.push("pushed")
      },
    })
    const handlers = createIpcHandlers(ctx)
    await handlers.checkForUpdate(undefined)
    expect(pushed).toEqual(["pushed"])
  })

  it("setUpdateChannel pushes the built state via pushUpdateState", async () => {
    const pushed: unknown[] = []
    const { ctx } = makeCtx({
      pushUpdateState: async () => {
        pushed.push("pushed")
      },
    })
    const handlers = createIpcHandlers(ctx)
    await handlers.setUpdateChannel({ channel: "canary" })
    expect(pushed).toEqual(["pushed"])
  })
})

describe("createIpcHandlers.getRunEvents", () => {
  it("returns the stored events for the requested session", async () => {
    const { ctx, runEventsIds } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)
    const result = await handlers.getRunEvents({ id: "s_1" as never })
    expect(result.events[0]?.event.type).toBe("runner-started")
    expect(runEventsIds).toEqual(["s_1"])
  })

  it("throws so the server surfaces handler-failed when the read fails", async () => {
    const { ctx } = makeCtx({
      providers: [provider()],
      runEvents: err({ kind: "db-failed", detail: "boom" }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.getRunEvents({ id: "s_x" as never }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers.updateHarnessPrefs", () => {
  it("persists the mode into settings.lastByHarness for the harness", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      mode: "plan",
    })

    expect(result).toBeNull()
    expect(saves.at(-1)?.settings.lastByHarness).toEqual({
      claude: { mode: "plan" },
    })
  })

  it("merges into existing entries without dropping other harnesses", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.updateHarnessPrefs({
      harnessId: "codex" as HarnessId,
      mode: "bypass",
    })
    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      mode: "plan",
    })

    expect(saves.at(-1)?.settings.lastByHarness).toEqual({
      codex: { mode: "bypass" },
      claude: { mode: "plan" },
    })
  })

  it("persists modelId without dropping a previously-set mode", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      mode: "plan",
    })
    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      modelId: "mdl_x",
    })

    expect(saves.at(-1)?.settings.lastByHarness).toEqual({
      claude: { mode: "plan", modelId: "mdl_x" },
    })
  })

  it("preserves a previously-set modelId when a later call updates only the mode", async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      modelId: "mdl_x",
    })
    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      mode: "plan",
    })

    expect(saves.at(-1)?.settings.lastByHarness).toEqual({
      claude: { mode: "plan", modelId: "mdl_x" },
    })
  })

  it('persists modelId "" (default/clear) when only a modelId is supplied', async () => {
    const { ctx, saves } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.updateHarnessPrefs({
      harnessId: "claude" as HarnessId,
      modelId: "",
    })

    expect(saves.at(-1)?.settings.lastByHarness).toEqual({
      claude: { modelId: "" },
    })
  })
})

describe("createIpcHandlers.launchHarness (persisted mode)", () => {
  it("forwards the persisted permission mode for the harness to runner.launch", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { mode: "plan" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as { permissionMode?: string }
    expect(input.permissionMode).toBe("plan")
  })

  it("omits permissionMode when nothing is stored for the harness", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("permissionMode" in input).toBe(false)
  })
})

describe("createIpcHandlers.launchHarness (persisted thinkingEffort)", () => {
  it("forwards the persisted thinkingEffort pref for the harness to runner.launch", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { thinkingEffort: "high" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as { thinkingEffort?: string }
    expect(input.thinkingEffort).toBe("high")
  })

  it("omits thinkingEffort when nothing is stored for the harness", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("thinkingEffort" in input).toBe(false)
  })

  it("omits thinkingEffort when the stored value is not a valid tier", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { thinkingEffort: "ultra" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("thinkingEffort" in input).toBe(false)
  })
})

describe("createIpcHandlers.launchHarness (persisted model)", () => {
  it("uses the persisted per-harness modelId when the launch carries none", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { modelId: "mdl_x" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    const input = runnerLaunchInputs[0] as { modelId?: string }
    expect(input.modelId).toBe("mdl_x")
  })

  it("prefers an explicit launch modelId over the persisted one", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { modelId: "mdl_persisted" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({
      id: "claude" as HarnessId,
      modelId: "mdl_explicit" as ModelId,
      env: {},
    })

    const input = runnerLaunchInputs[0] as { modelId?: string }
    expect(input.modelId).toBe("mdl_explicit")
  })
})

describe("createIpcHandlers.launchHarness (model default fallback)", () => {
  it("defaults the launch model to the first configured model when none is remembered", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      models: [
        {
          id: "mdl_a" as ModelId,
          providerId: "p1" as ProviderId,
          providerModel: "m",
          aliases: [] as string[],
          attachments: {},
        } satisfies ModelRoute,
      ],
      settings: { ...loaded.settings, lastByHarness: {} },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, cwd: "/tmp" })

    const input = runnerLaunchInputs[0] as { modelId?: string }
    expect(input.modelId).toBe("mdl_a") // proxied launch, not direct
  })

  it("keeps the explicit default (no model) when the remembered model is the empty sentinel", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({ providers: [provider()] })
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      models: [
        {
          id: "mdl_a" as ModelId,
          providerId: "p1" as ProviderId,
          providerModel: "m",
          aliases: [] as string[],
          attachments: {},
        } satisfies ModelRoute,
      ],
      settings: {
        ...loaded.settings,
        lastByHarness: { claude: { modelId: "" } },
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, cwd: "/tmp" })

    const input = runnerLaunchInputs[0] as Record<string, unknown>
    expect("modelId" in input).toBe(false) // direct: user opted into subscription
  })
})

describe("createIpcHandlers.getProviderCatalog", () => {
  it("returns the provider catalog with custom, ollama and openrouter entries", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    const catalog = await handlers.getProviderCatalog(undefined)
    const keys = catalog.map((e) => e.key)
    expect(keys).toContain("custom")
    expect(keys).toContain("ollama")
    expect(keys).toContain("openrouter")
  })
})

describe("createIpcHandlers.launchHarness selection", () => {
  it("launches a native harness via the runner manager", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      nativeHarnessId: "claude",
    })
    const handlers = createIpcHandlers(ctx)
    const result = await handlers.launchHarness({ id: "claude" as never })
    expect(result).toEqual({ sessionId: sampleSession.id })
    expect(runnerLaunchInputs).toHaveLength(1)
    // The resolved claude executable is forwarded so the SDK driver spawns it directly (its own
    // bundle-relative resolution finds no cli.js in the packaged app).
    expect(runnerLaunchInputs[0]).toMatchObject({
      command: "/usr/local/bin/claude",
    })
    // The resolved launch args are forwarded too (codex needs them for proxy routing; env-routed
    // harnesses ignore them).
    expect(runnerLaunchInputs[0]).toHaveProperty("args")
  })

  it("rejects a harness with no native driver instead of launching", async () => {
    const { ctx, runnerLaunchInputs } = makeCtx({
      providers: [provider()],
      nativeHarnessId: "__none__",
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.launchHarness({ id: "claude" as never }),
    ).rejects.toThrow()
    expect(runnerLaunchInputs).toHaveLength(0)
  })
})

describe("createIpcHandlers.launchHarness awaits ctx.ensureGuiPathResolved before launching", () => {
  it("resolves the async PATH enrichment before invoking ctx.runner.launch", async () => {
    // The handler must await ctx.ensureGuiPathResolved BEFORE reaching ctx.runner.launch so the
    // deferred GUI PATH probe has settled by the time `Bun.which(command, { PATH })` runs.
    // A launch that races the probe would surface as "command not found on PATH" in the
    // packaged GUI (the deferred spawn is the only path that knows the user's real PATH).
    const order: string[] = []
    const { ctx } = makeCtx({
      providers: [provider()],
      ensureGuiPathResolved: async () => {
        order.push("path-resolved")
      },
      runnerOk: true,
    })
    // Wrap the runner to record its invocation in the same ordered array.
    ;(ctx.runner as unknown as { launch: (input: unknown) => unknown }).launch =
      (input: unknown) => {
        order.push("launched")
        void input
        return ok({ sessionId: sampleSession.id })
      }
    const handlers = createIpcHandlers(ctx)

    await handlers.launchHarness({ id: "claude" as HarnessId, env: {} })

    expect(order).toEqual(["path-resolved", "launched"])
  })
})

// ── Update handlers ───────────────────────────────────────────────────────────

describe("createIpcHandlers update handlers", () => {
  it("checkForUpdate returns available===true, latestVersion, channel, showBanner===true when version is newer than dismissed", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashA",
    })
    const { ctx } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
      dismissedUpdateHash: null,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.checkForUpdate(undefined)

    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe("1.1.0")
    expect(result.latestHash).toBe("hashA")
    expect(result.channel).toBe("stable")
    expect(result.showBanner).toBe(true)
  })

  it("checkForUpdate returns showBanner===false when the available build hash was dismissed", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashA",
    })
    const { ctx } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
      dismissedUpdateHash: "hashA",
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.checkForUpdate(undefined)

    expect(result.available).toBe(true)
    expect(result.showBanner).toBe(false)
  })

  it("hides the banner for the dismissed hash and re-shows it for a new hash while the version is frozen", async () => {
    // The canary regression: canary CI never bumps package.json version, so
    // every canary build reports the SAME latestVersion. Only the build hash
    // changes. Dismissing hashA must NOT suppress a later hashB.
    const first = createFakeUpdater({
      currentVersion: "1.4.0",
      latest: "1.4.0",
      latestHash: "hashA",
    })
    const { ctx } = makeCtx({
      updater: first,
      updateChannel: "canary",
      dismissedUpdateHash: "hashA",
    })
    const handlers = createIpcHandlers(ctx)

    // hashA dismissed → banner hidden
    expect((await handlers.checkForUpdate(undefined)).showBanner).toBe(false)

    // Swap to a newer canary build: same version, new hash → banner re-shows.
    const second = createFakeUpdater({
      currentVersion: "1.4.0",
      latest: "1.4.0",
      latestHash: "hashB",
    })
    ;(ctx.updater as unknown as { getRaw: unknown }) = second
    const handlers2 = createIpcHandlers(ctx)
    const result = await handlers2.checkForUpdate(undefined)
    expect(result.latestVersion).toBe("1.4.0")
    expect(result.latestHash).toBe("hashB")
    expect(result.showBanner).toBe(true)
  })

  it("startUpdateDownload returns null and drives the fake updater to phase downloaded", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
    })
    const { ctx } = makeCtx({ updater: fakeUpdater })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.startUpdateDownload(undefined)

    expect(result).toBeNull()
    expect(fakeUpdater.getRaw().phase).toBe("downloaded")
  })

  it("dismissUpdate persists the dismissed build hash in config", async () => {
    const fakeUpdater = createFakeUpdater({ currentVersion: "1.0.0" })
    const { ctx, saves } = makeCtx({
      updater: fakeUpdater,
      dismissedUpdateHash: null,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.dismissUpdate({ hash: "hashA" })

    expect(result).toBeNull()
    expect(saves.at(-1)?.settings.dismissedUpdateHash).toBe("hashA")
  })

  it("setUpdateChannel switches the channel, persists it, and returns state with new channel", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.2.0",
    })
    const { ctx, saves } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
      dismissedUpdateVersion: null,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.setUpdateChannel({ channel: "canary" })

    expect(fakeUpdater.lastChannel).toBe("canary")
    expect(saves.at(-1)?.settings.updateChannel).toBe("canary")
    expect(result.channel).toBe("canary")
  })

  it("setUpdateChannel relaunches (and skips the post-switch check) on a cross-channel switch from a packaged build", async () => {
    // The fix: a stable→canary switch rewrites version.json (channel+name) and
    // relaunches so Electrobun's cached localInfo resets. The post-switch check
    // would run against the stale cached channel, so it is skipped on relaunch.
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.8.0",
      latest: "1.8.0-canary.2",
      latestHash: "canaryHash",
      buildChannel: "stable",
    })
    const { ctx, saves } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.setUpdateChannel({ channel: "canary" })

    expect(fakeUpdater.lastChannel).toBe("canary")
    expect(saves.at(-1)?.settings.updateChannel).toBe("canary")
    // Cross-channel (stable→canary) ⇒ relaunch fired, post-switch check NOT fired.
    expect(fakeUpdater.relaunchCalls).toBe(1)
    expect(fakeUpdater.checkCalls).toBe(0)
  })

  it("setUpdateChannel does NOT relaunch on a same-channel switch (canary→canary)", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.8.0-canary.2",
      buildChannel: "canary",
    })
    const { ctx } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "canary",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.setUpdateChannel({ channel: "canary" })

    // Same channel ⇒ no relaunch; the post-switch re-check still runs so the
    // returned state is fresh.
    expect(fakeUpdater.relaunchCalls).toBe(0)
    expect(fakeUpdater.checkCalls).toBe(1)
  })

  it("setUpdateChannel does NOT relaunch when the build channel is unknown (dev build)", async () => {
    // A dev build has no bundle name to migrate (channel: "dev") — the switch is
    // treated as a preference persist, not a migration. Dev is update-disabled.
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.8.0",
    })
    const { ctx, saves } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.setUpdateChannel({ channel: "canary" })

    expect(saves.at(-1)?.settings.updateChannel).toBe("canary")
    expect(fakeUpdater.relaunchCalls).toBe(0)
    expect(fakeUpdater.checkCalls).toBe(1)
  })

  it("applyUpdate returns null and drives the fake updater to phase applying", async () => {
    const updater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
    })
    const { ctx } = makeCtx({ updater })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.applyUpdate(undefined)

    // Fire-and-forget — FakeUpdater.apply() sets phase synchronously before resolving.
    await Promise.resolve()
    expect(result).toBeNull()
    expect(updater.getRaw().phase).toBe("applying")
  })

  it("getUpdateState shows the bundle's build channel even when config defaults to stable (canary build)", async () => {
    // The reported bug: a freshly-installed canary build showed the "stable"
    // channel because the displayed channel came only from the config default.
    // version.json (what Electrobun actually follows) is the source of truth.
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.2.3",
      buildChannel: "canary",
    })
    const { ctx } = makeCtx({
      updater: fakeUpdater,
      updateChannel: "stable",
      dismissedUpdateVersion: null,
    })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getUpdateState(undefined)

    expect(result.channel).toBe("canary")
  })
})

// ── getUpdateState config-load resilience ─────────────────────────────────────

describe("createIpcHandlers.getUpdateState (config-load resilience)", () => {
  it("returns a stable-channel state when config cannot load", async () => {
    const fakeUpdater = createFakeUpdater({
      currentVersion: "1.2.0",
    })
    const { ctx } = makeCtx({ updater: fakeUpdater })
    ;(ctx.config as { load: unknown }).load = async () =>
      err({ kind: "io", detail: "boom" })
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getUpdateState(undefined)

    expect(result.channel).toBe("stable")
    expect(result.currentVersion).toBe("1.2.0")
  })
})

// ── Delete + reset handlers ─────────────────────────────────────────────────

describe("createIpcHandlers.deleteSession", () => {
  it("delegates to ctx.dataAdmin.deleteSession and returns null on success", async () => {
    const { ctx, deletedSessionIds } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.deleteSession({ sessionId: "s_1" as never })

    expect(result).toBeNull()
    expect(deletedSessionIds).toEqual(["s_1"])
  })

  it("throws so the server surfaces handler-failed when the cascade delete fails", async () => {
    const { ctx } = makeCtx({
      deleteSessionResult: err({ kind: "db-failed", detail: "boom" }),
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.deleteSession({ sessionId: "s_1" as never }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers.deleteProject", () => {
  it("delegates to ctx.dataAdmin.deleteProject and returns null on success", async () => {
    const { ctx, deletedProjectIds } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.deleteProject({ projectId: "prj_1" as never })

    expect(result).toBeNull()
    expect(deletedProjectIds).toEqual(["prj_1"])
  })

  it("throws so the server surfaces handler-failed when the cascade delete fails", async () => {
    const { ctx } = makeCtx({
      deleteProjectResult: err({ kind: "db-failed", detail: "boom" }),
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.deleteProject({ projectId: "prj_1" as never }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers.renameSession", () => {
  it("trims the name, calls sessions.updateName, marks the run user-named, and returns null", async () => {
    const { ctx, renameSessionCalls, markUserNamedCalls } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    const r = await handlers.renameSession({
      sessionId: "s_1" as SessionId,
      name: "  New name  ",
    })
    expect(r).toBeNull()
    expect(renameSessionCalls).toEqual([
      { id: "s_1" as SessionId, name: "New name" },
    ])
    expect(markUserNamedCalls).toEqual(["s_1" as SessionId])
  })

  it("fails when the name is blank after trimming", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.renameSession({ sessionId: "s_1" as SessionId, name: "   " }),
    ).rejects.toThrow(/name is required/i)
  })

  it("fails with a session-not-found message when updateName returns not-found", async () => {
    const { ctx } = makeCtx({
      renameSessionResult: err({ kind: "not-found" }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.renameSession({ sessionId: "s_1" as SessionId, name: "x" }),
    ).rejects.toThrow(/not found/i)
  })
})

describe("createIpcHandlers.resetApp", () => {
  it("calls ctx.resetApp and returns null on success", async () => {
    const made = makeCtx()
    const handlers = createIpcHandlers(made.ctx)

    const result = await handlers.resetApp(undefined)

    expect(result).toBeNull()
    expect(made.resetCalls).toBe(1)
  })

  it("throws so the server surfaces handler-failed when the reset fails", async () => {
    const { ctx } = makeCtx({
      resetAppResult: err({ kind: "reset-failed", detail: "test" }),
    })
    const handlers = createIpcHandlers(ctx)

    await expect(handlers.resetApp(undefined)).rejects.toThrow()
  })
})

describe("createIpcHandlers fail() central logging", () => {
  it("logs an error on the ipc child scope before throwing when a handler hits fail()", async () => {
    const calls: Array<{ scope: string; msg: string }> = []
    const child = (scope: string): Logger => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => calls.push({ scope, msg }),
      fatal: (msg: string) => calls.push({ scope, msg }),
      child: () => child(scope),
    })
    const fakeLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child,
    }
    // Force loadConfig() to fail so getProviders() reaches fail("could not load config").
    const { ctx } = makeCtx({ log: fakeLog })
    ;(ctx.config as { load: unknown }).load = async () => err({ kind: "io" })
    const handlers = createIpcHandlers(ctx)

    // The thrown-error → handler-failed behavior is preserved (still throws) ...
    await expect(handlers.getProviders(undefined)).rejects.toThrow(
      "could not load config",
    )
    // ... AND the failure left a persisted trace: one error on the "ipc" scope.
    expect(calls).toEqual([{ scope: "ipc", msg: "could not load config" }])
  })
})

describe("createIpcHandlers.logClientError", () => {
  it("logClientError forwards a webview error to ctx.log", async () => {
    const calls: Array<{ scope: string; msg: string }> = []
    const child = (scope: string): Logger => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => calls.push({ scope, msg }),
      fatal: (msg: string) => calls.push({ scope, msg }),
      child: () => child(scope),
    })
    const fakeLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child,
    }
    const { ctx } = makeCtx({ log: fakeLog })
    const handlers = createIpcHandlers(ctx)
    const r = await handlers.logClientError({
      scope: "ErrorBoundary",
      level: "error",
      msg: "crash",
    })
    expect(r).toBeNull()
    expect(calls[0]?.msg).toBe("crash")
    expect(calls[0]?.scope).toBe("webview.ErrorBoundary")
  })
})

describe("createIpcHandlers.testProviderDraft", () => {
  it("validates config then delegates to ctx.testProviderDraft and returns ok+latency", async () => {
    const { ctx, draftTestInputs } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)
    const r = await handlers.testProviderDraft({
      sdkProvider: "openai",
      config: {},
      secrets: { apiKey: "sk-x" },
      providerModel: "gpt-4o",
    })
    expect(r).toEqual({ ok: true, latencyMs: 7 })
    expect(draftTestInputs).toEqual([
      {
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "sk-x" },
        providerModel: "gpt-4o",
      },
    ])
  })

  it("falls back to the sdkProvider name as the ping model when providerModel is empty", async () => {
    const { ctx, draftTestInputs } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)
    await handlers.testProviderDraft({
      sdkProvider: "openai",
      config: {},
      secrets: {},
      providerModel: "",
    })
    expect(
      (draftTestInputs[0] as { providerModel: string }).providerModel,
    ).toBe("openai")
  })

  it("rejects (handler-failed) when the draft config is invalid", async () => {
    const { ctx } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.testProviderDraft({
        sdkProvider: "custom",
        config: { headers: "not-json" },
        secrets: {},
        providerModel: "m",
      }),
    ).rejects.toThrow()
  })

  it("rejects a plugin provider key — connectivity probing has no plugin path yet", async () => {
    const { ctx } = makeCtx({
      providers: [],
      providerRegistry: createProviderRegistry([
        pluginDescriptor("plugin:acme"),
      ]),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.testProviderDraft({
        sdkProvider: "plugin:acme",
        config: {},
        secrets: {},
        providerModel: "m",
      }),
    ).rejects.toThrow(/provider draft test not supported for: plugin:acme/)
  })
})

describe("createIpcHandlers.listProviderModelsDraft", () => {
  it("returns the discovered models for inline inputs", async () => {
    const { ctx, draftListInputs } = makeCtx({ providers: [] })
    const handlers = createIpcHandlers(ctx)
    const r = await handlers.listProviderModelsDraft({
      sdkProvider: "openai",
      config: {},
      secrets: { apiKey: "sk-x" },
    })
    expect(r).toEqual({ models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] })
    expect(draftListInputs).toEqual([
      { sdkProvider: "openai", config: {}, secrets: { apiKey: "sk-x" } },
    ])
  })

  it("rejects (handler-failed) when discovery fails", async () => {
    const { ctx } = makeCtx({
      providers: [],
      draftListResult: err({ kind: "provider-failed" }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.listProviderModelsDraft({
        sdkProvider: "openai",
        config: {},
        secrets: {},
      }),
    ).rejects.toThrow()
  })

  it("surfaces the underlying discovery error detail (not a generic message)", async () => {
    const { ctx } = makeCtx({
      providers: [],
      draftListResult: err({
        kind: "provider-failed",
        detail: "HTTP 404 from http://localhost:11434/models",
      }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.listProviderModelsDraft({
        sdkProvider: "custom",
        config: { serverUrl: "http://localhost:11434" },
        secrets: {},
      }),
    ).rejects.toThrow(/HTTP 404 from http:\/\/localhost:11434\/models/)
  })

  it("rejects a plugin provider key — model discovery has no plugin path yet", async () => {
    const { ctx } = makeCtx({
      providers: [],
      providerRegistry: createProviderRegistry([
        pluginDescriptor("plugin:acme"),
      ]),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.listProviderModelsDraft({
        sdkProvider: "plugin:acme",
        config: {},
        secrets: {},
      }),
    ).rejects.toThrow(/provider model discovery not supported for: plugin:acme/)
  })
})

describe("createIpcHandlers.testProviderDraft (error detail)", () => {
  it("surfaces the underlying draft-test error detail", async () => {
    const { ctx } = makeCtx({
      providers: [],
      draftTestResult: err({
        kind: "provider-failed",
        detail: "boom from upstream",
      }),
    })
    const handlers = createIpcHandlers(ctx)
    await expect(
      handlers.testProviderDraft({
        sdkProvider: "openai",
        config: {},
        secrets: {},
        providerModel: "gpt-4o",
      }),
    ).rejects.toThrow(/provider draft test failed: boom from upstream/)
  })
})

describe("createIpcHandlers.getTimeoutSettings", () => {
  it("returns the default timeout values from config when nothing has been changed", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getTimeoutSettings(undefined)

    expect(result.firstTokenTimeoutMs).toBe(120000)
    expect(result.interTokenTimeoutMs).toBe(60000)
  })

  it("returns the persisted timeout values when config has non-default values", async () => {
    const { ctx } = makeCtx()
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: {
        ...loaded.settings,
        firstTokenTimeoutMs: 90000,
        interTokenTimeoutMs: 30000,
      },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.getTimeoutSettings(undefined)

    expect(result.firstTokenTimeoutMs).toBe(90000)
    expect(result.interTokenTimeoutMs).toBe(30000)
  })
})

describe("createIpcHandlers.updateTimeoutSettings", () => {
  it("persists both timeout values into settings when called with valid values", async () => {
    const { ctx, saves } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const result = await handlers.updateTimeoutSettings({
      firstTokenTimeoutMs: 90000,
      interTokenTimeoutMs: 45000,
    })

    expect(result).toBeNull()
    expect(saves.at(-1)?.settings.firstTokenTimeoutMs).toBe(90000)
    expect(saves.at(-1)?.settings.interTokenTimeoutMs).toBe(45000)
  })

  it("does not modify other settings fields when persisting timeout values", async () => {
    const { ctx, saves } = makeCtx({
      lastSelectedFolder: "/home/me",
      lastSelectedHarnessId: "claude",
    })
    const handlers = createIpcHandlers(ctx)

    await handlers.updateTimeoutSettings({
      firstTokenTimeoutMs: 60000,
      interTokenTimeoutMs: 20000,
    })

    const saved = saves.at(-1)
    expect(saved?.settings.lastSelectedFolder).toBe("/home/me")
    expect(saved?.settings.lastSelectedHarnessId).toBe("claude")
  })
})

describe("createIpcHandlers.getSessionNamingSettings", () => {
  it("returns the configured id when one has been persisted", async () => {
    const { ctx } = makeCtx()
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: { ...loaded.settings, sessionNameModelId: "mdl_1" },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.getSessionNamingSettings(undefined)

    expect(r).toEqual({ sessionNameModelId: "mdl_1" })
  })

  it("returns null when the session name model has not been set", async () => {
    const { ctx } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.getSessionNamingSettings(undefined)

    expect(r).toEqual({ sessionNameModelId: null })
  })
})

describe("createIpcHandlers.updateSessionNamingSettings", () => {
  it("persists the id into settings.sessionNameModelId and returns null on success", async () => {
    const { ctx, saves } = makeCtx()
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.updateSessionNamingSettings({
      sessionNameModelId: "mdl_2",
    })

    expect(r).toBeNull()
    expect(saves.at(-1)?.settings.sessionNameModelId).toBe("mdl_2")
  })

  it("persists null (off) when the caller clears the session name model", async () => {
    const { ctx, saves } = makeCtx()
    const loaded = unwrap(await ctx.config.load())
    await ctx.config.save({
      ...loaded,
      settings: { ...loaded.settings, sessionNameModelId: "mdl_will_clear" },
    } as Config)
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.updateSessionNamingSettings({
      sessionNameModelId: null,
    })

    expect(r).toBeNull()
    expect(saves.at(-1)?.settings.sessionNameModelId).toBeNull()
  })

  it("raises a handler error when the underlying save fails", async () => {
    const { ctx } = makeCtx()
    ;(ctx.config as { save: unknown }).save = async () => err({ kind: "io" })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.updateSessionNamingSettings({ sessionNameModelId: null }),
    ).rejects.toThrow()
  })
})

// ── D.7 media uploads (pickUploads / readUploadThumbnail / readUploadDataUrl / openUploadExternal) ──

describe("createIpcHandlers.pickUploads", () => {
  it("saves each picked file via ctx.uploadStore and returns its ref, rejecting unsupported kinds", async () => {
    const { ctx, uploadSaveInputs } = makeCtx({
      pickFilesResult: ["/tmp/a.png", "/tmp/b.pdf"],
    })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.pickUploads({
      acceptedMimes: ["image/png", "application/pdf"],
      acceptedKinds: ["image"],
    })

    // The image was saved; the PDF (kind:"pdf") was rejected — only the .png survives.
    expect(r.uploads).toHaveLength(1)
    expect(r.uploads[0]?.displayName).toBe("a.png")
    expect(r.uploads[0]?.kind).toBe("image")
    expect(r.uploads[0]?.mime).toBe("image/png")
    expect(r.rejected).toEqual([
      { displayName: "b.pdf", reason: "unsupported-kind" },
    ])
    // The save call carried the image mime derived from the extension.
    expect(uploadSaveInputs).toEqual([
      {
        sourcePath: "/tmp/a.png",
        mime: "image/png",
        displayName: "a.png",
        maxBytes: 10 * 1024 * 1024,
      },
    ])
  })

  it("collects rejected entries for files whose kind is not in acceptedKinds", async () => {
    const { ctx, uploadSaveInputs } = makeCtx({
      pickFilesResult: ["/tmp/a.pdf"],
    })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.pickUploads({
      acceptedMimes: ["application/pdf"],
      acceptedKinds: ["image"],
    })

    expect(r.uploads).toEqual([])
    expect(r.rejected).toEqual([
      { displayName: "a.pdf", reason: "unsupported-kind" },
    ])
    expect(uploadSaveInputs).toEqual([])
  })

  it("omits the rejected field entirely when every pick was accepted", async () => {
    const { ctx } = makeCtx({ pickFilesResult: ["/tmp/a.png"] })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.pickUploads({
      acceptedMimes: ["image/png"],
      acceptedKinds: ["image"],
    })

    expect(r.uploads).toHaveLength(1)
    expect("rejected" in r).toBe(false)
  })
})

describe("createIpcHandlers.saveDroppedUploads", () => {
  it("saves dropped bytes via ctx.uploadStore.saveBytes and rejects unsupported kinds", async () => {
    const { ctx, uploadSaveBytesInputs } = makeCtx({})
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.saveDroppedUploads({
      files: [
        {
          displayName: "a.png",
          mime: "image/png",
          dataBase64: Buffer.from("img").toString("base64"),
        },
        {
          displayName: "b.pdf",
          mime: "application/pdf",
          dataBase64: Buffer.from("pdf").toString("base64"),
        },
      ],
      acceptedKinds: ["image"],
    })

    expect(r.uploads).toHaveLength(1)
    expect(r.uploads[0]?.displayName).toBe("a.png")
    expect(r.rejected).toEqual([
      { displayName: "b.pdf", reason: "unsupported-kind" },
    ])
    expect(uploadSaveBytesInputs).toEqual([
      {
        data: new Uint8Array(Buffer.from("img")),
        mime: "image/png",
        displayName: "a.png",
        maxBytes: 10 * 1024 * 1024,
      },
    ])
  })

  it("falls back to the extension-inferred mime when a dropped file reports an empty mime", async () => {
    const { ctx, uploadSaveBytesInputs } = makeCtx({})
    const handlers = createIpcHandlers(ctx)

    await handlers.saveDroppedUploads({
      files: [
        {
          displayName: "shot.png",
          mime: "",
          dataBase64: Buffer.from("x").toString("base64"),
        },
      ],
      acceptedKinds: ["image"],
    })

    expect(uploadSaveBytesInputs[0]?.mime).toBe("image/png")
  })
})

describe("createIpcHandlers.readUploadThumbnail", () => {
  it("builds a data:<mime>;base64,<base64> URL from uploadStore.readBase64", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => ok("aGVsbG8="),
      pathOf: async () => err({ kind: "not-found", detail: "unused" }),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.readUploadThumbnail({
      id: "sha_abc",
      mime: "image/png",
    })

    expect(r).toEqual({ dataUrl: "data:image/png;base64,aGVsbG8=" })
  })

  it("returns { missing: true } when uploadStore.exists is false", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => err({ kind: "not-found", detail: "unused" }),
      exists: async () => false,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.readUploadThumbnail({
      id: "sha_ghost",
      mime: "image/png",
    })

    expect(r).toEqual({ missing: true })
  })
})

describe("createIpcHandlers.readUploadDataUrl", () => {
  it("builds a data:<mime>;base64,<base64> URL from uploadStore.readBase64", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => ok("aGVsbG8="),
      pathOf: async () => err({ kind: "not-found", detail: "unused" }),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.readUploadDataUrl({
      id: "sha_abc",
      mime: "image/png",
    })

    expect(r).toEqual({ dataUrl: "data:image/png;base64,aGVsbG8=" })
  })

  it("returns { missing: true } when uploadStore.exists is false", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => err({ kind: "not-found", detail: "unused" }),
      exists: async () => false,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.readUploadDataUrl({
      id: "sha_ghost",
      mime: "image/png",
    })

    expect(r).toEqual({ missing: true })
  })
})

describe("createIpcHandlers.openUploadExternal", () => {
  it("delegates a file:// URL built from pathOf(id) to ctx.openExternalUrl and returns null on success", async () => {
    const uploadsDir = "/tmp/uploads"
    const openExternalUrlCalls: string[] = []
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => ok(`${uploadsDir}/sha_abc.pdf`),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    // Force the fake paths.uploadsDir to the expected value.
    ;(ctx as { paths: { uploadsDir: string } }).paths.uploadsDir = uploadsDir
    // Override the fake ctx.openExternalUrl to record the call + succeed.
    ;(
      ctx as { openExternalUrl: (url: string) => Promise<boolean> }
    ).openExternalUrl = async (url: string) => {
      openExternalUrlCalls.push(url)
      return true
    }
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.openUploadExternal({ id: "sha_abc" })

    expect(r).toBeNull()
    expect(openExternalUrlCalls).toEqual([`file://${uploadsDir}/sha_abc.pdf`])
  })

  it("returns { missing: true } when pathOf is not-found", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => err({ kind: "not-found", detail: "ghost" }),
      exists: async () => false,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.openUploadExternal({ id: "sha_ghost" })

    expect(r).toEqual({ missing: true })
  })

  it("returns { opened: false } (NOT { missing }) when pathOf resolves to a path outside ctx.paths.uploadsDir", async () => {
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => ok("/etc/passwd"),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    ;(ctx as { paths: { uploadsDir: string } }).paths.uploadsDir =
      "/var/spectrum/uploads"
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.openUploadExternal({ id: "sha_evil" })

    // The security check rejects it BEFORE calling openExternalUrl — the handler
    // returns a non-null failure marker so the webview can surface a toast.
    expect(r).toEqual({ opened: false })
  })

  it("accepts a Windows-style absolute path inside ctx.paths.uploadsDir", async () => {
    // On Windows, uploads live under a drive-letter root like
    // `C:\Users\me\AppData\Roaming\Spectrum\uploads\sha.png`. The security
    // check MUST treat drive-letter roots as absolute (the `startsWith("/")`
    // form was macOS/Linux-only and silently rejected every Windows path).
    const winUploadsDir = "C:\\Users\\me\\AppData\\Roaming\\Spectrum\\uploads"
    const winPath = `${winUploadsDir}\\sha_abc.pdf`
    const openExternalUrlCalls: string[] = []
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => ok(winPath),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    ;(ctx as { paths: { uploadsDir: string } }).paths.uploadsDir = winUploadsDir
    ;(
      ctx as { openExternalUrl: (url: string) => Promise<boolean> }
    ).openExternalUrl = async (url: string) => {
      openExternalUrlCalls.push(url)
      return true
    }
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.openUploadExternal({ id: "sha_abc" })

    expect(r).toBeNull()
    expect(openExternalUrlCalls).toEqual([`file://${winPath}`])
  })

  it("still rejects a Windows-style path that escapes ctx.paths.uploadsDir", async () => {
    const winUploadsDir = "C:\\Users\\me\\AppData\\Roaming\\Spectrum\\uploads"
    const winEvilPath = "C:\\Windows\\System32\\drivers\\etc\\hosts"
    const uploadStore: UploadStore = {
      save: async () => err({ kind: "io-failed", detail: "unused" }),
      saveBytes: async () => err({ kind: "io-failed", detail: "stub" }),
      readBase64: async () => err({ kind: "not-found", detail: "unused" }),
      pathOf: async () => ok(winEvilPath),
      exists: async () => true,
      size: async () => 0,
    }
    const { ctx } = makeCtx({ uploadStore })
    ;(ctx as { paths: { uploadsDir: string } }).paths.uploadsDir = winUploadsDir
    const handlers = createIpcHandlers(ctx)

    const r = await handlers.openUploadExternal({ id: "sha_evil" })

    expect(r).toEqual({ opened: false })
  })
})
