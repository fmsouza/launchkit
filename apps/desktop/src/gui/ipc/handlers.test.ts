import { describe, it, expect } from "bun:test"
import { ok, err, type Result } from "@launchkit/utils"
import type { Provider, Session } from "@launchkit/types"
import type { Config } from "@launchkit/config"
import { createIpcHandlers } from "./handlers"
import type { AppContext } from "../../composition"

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

const baseConfig = (providers: readonly Provider[]): Config =>
  ({
    version: 2,
    providers,
    aliases: [],
    settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
  }) as Config

/** Build a fake AppContext, capturing every save + secret set so tests can assert behavior. */
const makeCtx = (
  over: {
    providers?: readonly Provider[]
    setResult?: Result<{ readonly ref: string }, { readonly kind: string }>
    proxyRunning?: boolean
    proxyPort?: number
    session?: Session
    launchOk?: boolean
  } = {},
): {
  ctx: AppContext
  saves: Config[]
  secretSets: string[]
  launchParams: unknown[]
  sessionInputs: unknown[]
} => {
  const saves: Config[] = []
  const secretSets: string[] = []
  const launchParams: unknown[] = []
  const sessionInputs: unknown[] = []
  let current = baseConfig(over.providers ?? [provider()])

  const ctx = {
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
    },
    launch: (params: unknown) => {
      launchParams.push(params)
      return over.launchOk === false
        ? err({ kind: "spawn-failed", detail: "ENOENT" })
        : ok({ pid: 4321 })
    },
    proxy: {
      isRunning: async () => over.proxyRunning ?? true,
      start: () => ({ hostname: "127.0.0.1", port: over.proxyPort ?? 4000, stop: () => {} }),
    },
    proxyPort: over.proxyPort ?? 4000,
    proxyBaseUrl: `http://127.0.0.1:${over.proxyPort ?? 4000}`,
    testProvider: async () => ok({ ok: true, latencyMs: 12 }),
    registry: {
      list: async () => ok([{ id: "claude", name: "Claude Code", command: "claude", apiFormat: "anthropic", envTemplate: {}, defaultAlias: "default", builtIn: true }]),
    },
    genProxyKey: () => "test-key",
    factory: {},
    gateway: {},
    paths: { configFile: "/tmp/config.json", dbFile: "/tmp/launchkit.db", harnessDir: "/tmp/harnesses" },
  } as unknown as AppContext

  return { ctx, saves, secretSets, launchParams, sessionInputs }
}

const sampleSession: Session = {
  id: "s_1",
  harnessId: "claude",
  alias: "default",
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
        id: "p_openai",
        name: "OpenAI",
        sdkProvider: "openai",
        config: { baseUrl: "https://api.openai.com/v1" },
        secretFields: { apiKey: { isSet: true } },
        models: ["gpt-4o"],
      },
    ])
  })

  it("never emits a secret ref or value in the ProviderView when listing", async () => {
    const { ctx } = makeCtx({ providers: [provider({ secrets: { apiKey: { ref: "kc_secret_ref" } } })] })
    const handlers = createIpcHandlers(ctx)

    const serialized = JSON.stringify(await handlers.getProviders(undefined))

    expect(serialized).not.toContain("kc_secret_ref")
    expect(serialized).not.toContain('"ref"')
    expect(serialized).not.toContain("sk-")
  })

  it("marks a secret field isSet:true for every keychain ref the provider holds", async () => {
    const { ctx } = makeCtx({
      providers: [provider({ secrets: { apiKey: { ref: "kc_a" }, secretAccessKey: { ref: "kc_b" } } })],
    })
    const handlers = createIpcHandlers(ctx)

    const [view] = await handlers.getProviders(undefined)

    expect(view?.secretFields).toEqual({ apiKey: { isSet: true }, secretAccessKey: { isSet: true } })
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
    const saved = saves[0]?.providers.find((p) => p.id === ("p_openai" as never))
    expect(saved?.secrets).toEqual({ apiKey: { ref: "kc_minted" } })
  })

  it("throws so the server surfaces handler-failed when the keychain set fails", async () => {
    const { ctx } = makeCtx({
      providers: [provider({ secrets: {} })],
      setResult: err({ kind: "backend-failed" }),
    })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.setProviderSecret({ providerId: "p_openai" as never, field: "apiKey", value: "sk-x" }),
    ).rejects.toThrow()
  })

  it("throws when setProviderSecret targets a provider id that does not exist", async () => {
    const { ctx } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    await expect(
      handlers.setProviderSecret({ providerId: "p_ghost" as never, field: "apiKey", value: "sk-x" }),
    ).rejects.toThrow()
  })
})

describe("createIpcHandlers.launchHarness", () => {
  it("launches via ctx.launch and records a session, returning the created Session", async () => {
    const { ctx, launchParams, sessionInputs } = makeCtx({ providers: [provider()] })
    const handlers = createIpcHandlers(ctx)

    const session = await handlers.launchHarness({ id: "claude" as never, alias: "fast" as never })

    expect(session).toEqual(sampleSession)
    expect(launchParams).toHaveLength(1)
    expect(sessionInputs).toEqual([{ harnessId: "claude", alias: "fast" }])
  })

  it("throws so the server surfaces handler-failed when the launcher fails to spawn", async () => {
    const { ctx } = makeCtx({ providers: [provider()], launchOk: false })
    const handlers = createIpcHandlers(ctx)

    await expect(handlers.launchHarness({ id: "claude" as never })).rejects.toThrow()
  })
})

describe("createIpcHandlers.getProxyStatus", () => {
  it("reports running:true and the bound port when the proxy is up", async () => {
    const { ctx } = makeCtx({ proxyRunning: true, proxyPort: 4000 })
    const handlers = createIpcHandlers(ctx)

    expect(await handlers.getProxyStatus(undefined)).toEqual({ running: true, port: 4000 })
  })

  it("reports running:false when the proxy is not up", async () => {
    const { ctx } = makeCtx({ proxyRunning: false, proxyPort: 4000 })
    const handlers = createIpcHandlers(ctx)

    expect(await handlers.getProxyStatus(undefined)).toEqual({ running: false, port: 4000 })
  })
})
