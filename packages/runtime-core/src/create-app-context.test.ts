import { describe, expect, it } from "bun:test"
import {
  claude,
  createInMemoryHarnessFileSource,
  createRegistry,
} from "@spectrum/harnesses"
import { resolveAppPaths } from "@spectrum/platform"
import { createFakeCommandResolver } from "@spectrum/proc"
import { createProjectStore } from "@spectrum/projects"
import { createInMemoryRuntimeState } from "@spectrum/proxy"
import type { HarnessId } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { createAppContext } from "./create-app-context"
import type { CreateAppContextDeps } from "./deps"

/** Record which constructor saw which argument, returning inert stand-ins. */
const makeFakeDeps = (): {
  deps: CreateAppContextDeps
  calls: Record<string, unknown[]>
} => {
  const calls: Record<string, unknown[]> = {}
  const record =
    (name: string) =>
    (...args: unknown[]): unknown => {
      calls[name] = args
      return { __stub: name }
    }
  const deps: CreateAppContextDeps = {
    homeDir: () => "/home/tester",
    platform: "linux",
    env: {},
    resolveAppPaths,
    ensureDir: ((dir: string) => {
      calls.ensureDir = [dir]
    }) as never,
    migrateLegacyMacosConfig: record("migrateLegacyMacosConfig") as never,
    migrateLaunchkitToSpectrum: record("migrateLaunchkitToSpectrum") as never,
    migrateProductionToCanary: record("migrateProductionToCanary") as never,
    createFsConfigFile: record("createFsConfigFile") as never,
    createFileConfigStore: record("createFileConfigStore") as never,
    createCachedConfigStore: record("createCachedConfigStore") as never,
    createPlatformKeychainBackend: record(
      "createPlatformKeychainBackend",
    ) as never,
    createSecretFileOps: record("createSecretFileOps") as never,
    secretPassphrase: (async () => null) as never,
    createBunProcessRunner: record("createBunProcessRunner") as never,
    createCryptoIdGen: record("createCryptoIdGen") as never,
    createSecretStore: record("createSecretStore") as never,
    createSqliteClient: ((path: string) => {
      record("createSqliteClient")(path)
      return { ok: true, value: { __stub: "dbClient" } }
    }) as never,
    runMigrations: ((client: unknown) => {
      record("runMigrations")(client)
      return { ok: true, value: undefined }
    }) as never,
    createSystemClock: ((..._a: unknown[]) => {
      calls.createSystemClock = _a
      return { now: () => new Date(0) }
    }) as never,
    createSessionStore: ((..._a: unknown[]) => {
      calls.createSessionStore = _a
      return {
        create: () => ok(undefined),
        close: () => ok(undefined),
        query: () => ok([]),
        reconcileOrphaned: () => ok(0),
      }
    }) as never,
    createProjectStore: createProjectStore,
    createRegistry: record("createRegistry") as never,
    createPathCommandResolver: record("createPathCommandResolver") as never,
    createBunProcessSpawner: record("createBunProcessSpawner") as never,
    launchHarness: ((..._a: unknown[]) => {
      calls.launchHarness = _a
      return (..._p: unknown[]) => ok({ pid: 1, exited: Promise.resolve(0) })
    }) as never,
    createProviderFactory: record("createProviderFactory") as never,
    loadSdk: (async () => ({ create: () => ({}) })) as never,
    createRealGateway: record("createRealGateway") as never,
    createFileRuntimeState: record("createFileRuntimeState") as never,
    genProxyKey: () => "fixed-test-key",
    createRunStore: ((..._a: unknown[]) => {
      calls.createRunStore = _a
      return { append: () => ok({ seq: 0 }), read: () => ok([]) }
    }) as never,
    createFakeDriver: (() => ({ start: () => ok({}) })) as never,
    createAcpDriver: (() => ({ start: () => ok({}) })) as never,
    createDataAdmin: (() => ({
      deleteSession: () => ok(undefined),
      deleteProject: () => ok(undefined),
    })) as never,
    createUploadStore: ((args: { readonly uploadsDir: string }) => {
      calls.createUploadStore = [args]
      return { __stub: "createUploadStore" }
    }) as never,
    demoHarnessEnabled: false,
    readBuildChannel: () => undefined,
  }
  return { deps, calls }
}

describe("createAppContext listProviderModels wiring", () => {
  it("exposes ctx.listProviderModels as a function on the context", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.listProviderModels).toBe("function")
  })

  it("returns err when the provider id is not found in the config", async () => {
    const { deps } = makeFakeDeps()
    // Override the fake config store to return a config with no providers.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [],
            models: [],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })
    const ctx = createAppContext(deps)
    const result = await ctx.listProviderModels("p_ghost")
    expect(result.ok).toBe(false)
  })

  it("returns err and does NOT call the lister when the provider has an apiKey ref but secrets.get fails", async () => {
    const { deps } = makeFakeDeps()

    // Provider with an apiKey ref present in secrets.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [
              {
                id: "p_groq",
                sdkProvider: "groq",
                label: "Groq",
                models: ["llama3-8b-8192"],
                config: {},
                secrets: { apiKey: { ref: "kc_missing" } },
              },
            ],
            models: [],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    // secrets.get always fails (keychain entry gone / corrupted).
    ;(deps as { createSecretStore: unknown }).createSecretStore = () => ({
      set: async () => ok({ ref: "kc_new" }),
      get: async () => err({ kind: "not-found" } as { kind: "not-found" }),
      delete: async () => ok(undefined),
      has: async () => false,
    })

    const ctx = createAppContext(deps)
    const result = await ctx.listProviderModels("p_groq")

    // The error from secrets.get must be forwarded immediately — the lister
    // (and any outbound HTTP call) must not be reached.
    // We confirm "not reached" structurally: the error kind must be "not-found"
    // (the secrets error), NOT "provider-failed" or "unsupported-model-discovery".
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.error as { kind: string }).kind).toBe("not-found")
    }
  })

  it("returns unsupported-provider error when the provider has a plugin key", async () => {
    const { deps } = makeFakeDeps()

    // Provider with a plugin key.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [
              {
                id: "p_plugin",
                sdkProvider: "plugin:my-provider" as never,
                label: "Plugin Provider",
                models: ["model1"],
                config: {},
                secrets: {},
              },
            ],
            models: [],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)
    const result = await ctx.listProviderModels("p_plugin")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.error as { kind: string }).kind).toBe(
        "unsupported-provider",
      )
    }
  })
})

describe("createAppContext wiring", () => {
  it("builds the config store as a cached store wrapping a file store over an fs config file", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    // fs file is created at the resolved config path under the home dir
    expect(calls.createFsConfigFile?.[0] as string).toContain(
      "/home/tester/.config/spectrum/config.json",
    )
    // the file store receives that fs file ...
    const fileStoreArg = calls.createFileConfigStore?.[0] as {
      file: unknown
      logger: { child: unknown }
    }
    expect(fileStoreArg.file).toEqual({ __stub: "createFsConfigFile" })
    // ... and an injected (scoped) logger
    expect(typeof fileStoreArg.logger.child).toBe("function")
    // ... and the cached store wraps the file store
    expect(calls.createCachedConfigStore?.[0]).toEqual({
      __stub: "createFileConfigStore",
    })
  })

  it("builds the secret store from a platform keychain backend wired with paths + passphrase", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)
    const arg = calls.createPlatformKeychainBackend?.[0] as {
      platform: string
      runner: unknown
      fileOps: unknown
      secretsDir: string
      secretPassphrase: unknown
    }
    expect(arg.platform).toBe("linux")
    expect(arg.runner).toEqual({ __stub: "createBunProcessRunner" })
    expect(arg.fileOps).toEqual({ __stub: "createSecretFileOps" })
    expect(arg.secretsDir).toBe("/home/tester/.config/spectrum/secrets")
    expect(typeof arg.secretPassphrase).toBe("function")
    const secretStoreArg = calls.createSecretStore?.[0] as {
      backend: unknown
      idGen: unknown
      logger: { child: unknown }
    }
    expect(secretStoreArg.backend).toEqual({
      __stub: "createPlatformKeychainBackend",
    })
    expect(secretStoreArg.idGen).toEqual({ __stub: "createCryptoIdGen" })
    expect(typeof secretStoreArg.logger.child).toBe("function")
  })

  it("builds the session store from a bun:sqlite database at the resolved db path with a system clock", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    expect(calls.createSqliteClient?.[0] as string).toContain(
      "/home/tester/.config/spectrum/spectrum.db",
    )
    const sessionArgs = calls.createSessionStore?.[0] as {
      db: unknown
      clock: unknown
      idGen: unknown
    }
    expect(sessionArgs.db).toEqual({ __stub: "dbClient" })
    expect(typeof (sessionArgs.clock as { now?: unknown }).now).toBe("function")
  })

  it("creates the data directory before opening the database (fresh install)", () => {
    const { deps, calls } = makeFakeDeps()
    const order: string[] = []
    const ensureDirs: string[] = []
    const ensureDir = ((dir: string) => {
      order.push("ensureDir")
      ensureDirs.push(dir)
      calls.ensureDir = [dir]
    }) as never
    const createSqliteClient = ((path: string) => {
      order.push("db")
      calls.createSqliteClient = [path]
      return { ok: true, value: { __stub: "dbClient" } }
    }) as never
    createAppContext({ ...deps, ensureDir, createSqliteClient })

    const expected = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: {},
    })
    // The data dir is created (recursively) before the db open, or a fresh install
    // (no dir yet) throws on `new Database(path)` and the proxy never starts. Task 8 also
    // ensures the uploads dir (sibling of dataDir) so it's observable from `paths.uploadsDir`
    // immediately; that ensure happens AFTER the dataDir one but still before the db open.
    expect(ensureDirs[0]).toBe(expected.dataDir)
    expect(ensureDirs).toContain(expected.uploadsDir)
    expect(order.indexOf("ensureDir")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("ensureDir")).toBeLessThan(order.indexOf("db"))
  })

  it("builds the runtime state at the resolved runtime.json path and exposes it", () => {
    const { deps, calls } = makeFakeDeps()
    const ctx = createAppContext(deps)

    expect(calls.createFileRuntimeState?.[0] as string).toContain(
      "/home/tester/.config/spectrum/runtime.json",
    )
    // runtime is decorated by withRuntimeKeyRegistration (registers a restored/written proxy key
    // for redaction), so it is no longer the raw stub — assert the wrapper exposes the RuntimeState shape.
    expect(typeof ctx.runtime.readProxyKey).toBe("function")
    expect(typeof ctx.runtime.writeProxyKey).toBe("function")
    expect(typeof ctx.runtime.clear).toBe("function")
  })

  it("runs migrations against the opened client so the schema exists before first use", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)
    // runMigrations must receive the client returned by createSqliteClient,
    // proving open -> migrate -> build-store ordering.
    expect(calls.runMigrations?.[0]).toEqual({ __stub: "dbClient" })
  })

  it("builds the harness registry from an in-memory (builtins-only) file source", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    const arg = calls.createRegistry?.[0] as { fileSource?: unknown }
    // No directory file source is wired (custom user harnesses are gone); the registry receives an
    // in-memory file source so it lists only the builtins.
    expect(typeof arg.fileSource).toBe("object")
    expect(arg.fileSource).not.toBeNull()
  })

  it("partially applies launchHarness with the real resolver + spawner", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    const launchArg = calls.launchHarness?.[0] as {
      resolver: unknown
      spawner: unknown
      logger: { child: unknown }
    }
    expect(launchArg.resolver).toEqual({
      __stub: "createPathCommandResolver",
    })
    expect(launchArg.spawner).toEqual({ __stub: "createBunProcessSpawner" })
    // ... and an injected (scoped) logger
    expect(typeof launchArg.logger.child).toBe("function")
  })

  it("builds the provider factory with the secret store + loadSdk seam", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    const factoryArgs = calls.createProviderFactory?.[0] as {
      secretStore: {
        get: unknown
        set: unknown
        delete: unknown
        has: unknown
      }
      loadSdk: unknown
    }
    // The secret store is wrapped by withSecretRegistration (for log redaction) before being
    // handed to the factory, so it is the decorator (delegating to the stub), not the raw stub.
    expect(typeof factoryArgs.secretStore.get).toBe("function")
    expect(typeof factoryArgs.secretStore.set).toBe("function")
    expect(typeof factoryArgs.secretStore.delete).toBe("function")
    expect(typeof factoryArgs.secretStore.has).toBe("function")
    expect(typeof factoryArgs.loadSdk).toBe("function")
  })

  it("exposes the loopback proxy base url and port resolved from default config", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    // default config settings: 127.0.0.1:4000
    expect(ctx.proxyBaseUrl).toBe("http://127.0.0.1:4000")
    expect(ctx.proxyPort).toBe(4000)
  })

  it("offsets the proxy port for canary (base + 1)", () => {
    const { deps } = makeFakeDeps()
    ;(deps as { readBuildChannel: unknown }).readBuildChannel = () => "canary"
    const ctx = createAppContext(deps)
    expect(ctx.proxyPort).toBe(4001)
    expect(ctx.proxyBaseUrl).toBe("http://127.0.0.1:4001")
  })

  it("keeps port 4000 for stable (offset 0)", () => {
    const { deps } = makeFakeDeps()
    ;(deps as { readBuildChannel: unknown }).readBuildChannel = () => "stable"
    const ctx = createAppContext(deps)
    expect(ctx.proxyPort).toBe(4000)
    expect(ctx.proxyBaseUrl).toBe("http://127.0.0.1:4000")
  })

  it("exposes a projects store on the context", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.projects.list).toBe("function")
  })

  it("exposes a structured logger with all severity methods and child scoping", () => {
    const ctx = createAppContext(makeFakeDeps().deps)
    expect(typeof ctx.log.info).toBe("function")
    expect(typeof ctx.log.debug).toBe("function")
    expect(typeof ctx.log.warn).toBe("function")
    expect(typeof ctx.log.error).toBe("function")
    expect(typeof ctx.log.fatal).toBe("function")
    // child returns a Logger and logging never throws (clock stub is never invoked at construction)
    expect(() => ctx.log.child("test")).not.toThrow()
  })

  it("runs the legacy macOS migration with the injected platform/home/env before resolving paths", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)
    expect(calls.migrateLegacyMacosConfig?.[0]).toEqual({
      platform: "linux",
      homeDir: "/home/tester",
      env: {},
    })
  })

  it("runs the LaunchKit→Spectrum migration with the injected platform/home/env after the legacy migration", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)
    expect(calls.migrateLaunchkitToSpectrum?.[0]).toEqual({
      platform: "linux",
      homeDir: "/home/tester",
      env: {},
    })
  })

  it("runs migrateLegacyMacosConfig before migrateLaunchkitToSpectrum (data migration order)", () => {
    const { deps, calls } = makeFakeDeps()
    const order: string[] = []
    const migrateLegacyMacosConfig = ((...args: unknown[]) => {
      order.push("migrateLegacyMacosConfig")
      calls.migrateLegacyMacosConfig = args
    }) as never
    const migrateLaunchkitToSpectrum = ((...args: unknown[]) => {
      order.push("migrateLaunchkitToSpectrum")
      calls.migrateLaunchkitToSpectrum = args
    }) as never
    createAppContext({
      ...deps,
      migrateLegacyMacosConfig,
      migrateLaunchkitToSpectrum,
    })

    expect(order.indexOf("migrateLegacyMacosConfig")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("migrateLaunchkitToSpectrum")).toBeGreaterThanOrEqual(
      0,
    )
    expect(order.indexOf("migrateLegacyMacosConfig")).toBeLessThan(
      order.indexOf("migrateLaunchkitToSpectrum"),
    )
  })
})

describe("createAppContext dev/prod data isolation", () => {
  it("forwards appEnv=development and skips legacy migrations under SPECTRUM_ENV=development", () => {
    const { deps, calls } = makeFakeDeps()
    ;(deps as { env: unknown }).env = { SPECTRUM_ENV: "development" }
    ;(deps as { resolveAppPaths: unknown }).resolveAppPaths = (
      input: Parameters<typeof resolveAppPaths>[0],
    ) => {
      calls.resolveAppPaths = [input]
      return resolveAppPaths(input)
    }

    createAppContext(deps)

    expect((calls.resolveAppPaths?.[0] as { appEnv?: string }).appEnv).toBe(
      "development",
    )
    expect(
      (calls.createPlatformKeychainBackend?.[0] as { keychainService?: string })
        .keychainService,
    ).toBe("spectrum-dev")
    expect(calls.migrateLegacyMacosConfig).toBeUndefined()
    expect(calls.migrateLaunchkitToSpectrum).toBeUndefined()
  })

  it("forwards appEnv=production and runs legacy migrations when SPECTRUM_ENV is unset", () => {
    const { deps, calls } = makeFakeDeps()
    ;(deps as { resolveAppPaths: unknown }).resolveAppPaths = (
      input: Parameters<typeof resolveAppPaths>[0],
    ) => {
      calls.resolveAppPaths = [input]
      return resolveAppPaths(input)
    }

    createAppContext(deps)

    expect((calls.resolveAppPaths?.[0] as { appEnv?: string }).appEnv).toBe(
      "production",
    )
    expect(
      (calls.createPlatformKeychainBackend?.[0] as { keychainService?: string })
        .keychainService,
    ).toBe("spectrum")
    expect(calls.migrateLegacyMacosConfig).toBeDefined()
    expect(calls.migrateLaunchkitToSpectrum).toBeDefined()
  })

  it("resolves production appEnv when buildChannel is stable even if SPECTRUM_ENV=development", () => {
    const { deps, calls } = makeFakeDeps()
    ;(deps as { env: unknown }).env = { SPECTRUM_ENV: "development" }
    ;(deps as { readBuildChannel: unknown }).readBuildChannel = () => "stable"
    ;(deps as { resolveAppPaths: unknown }).resolveAppPaths = (
      input: Parameters<typeof resolveAppPaths>[0],
    ) => {
      calls.resolveAppPaths = [input]
      return resolveAppPaths(input)
    }

    createAppContext(deps)

    expect((calls.resolveAppPaths?.[0] as { appEnv?: string }).appEnv).toBe(
      "production",
    )
    expect(
      (calls.createPlatformKeychainBackend?.[0] as { keychainService?: string })
        .keychainService,
    ).toBe("spectrum")
  })

  it("resolves development appEnv when buildChannel is dev", () => {
    const { deps, calls } = makeFakeDeps()
    ;(deps as { env: unknown }).env = {}
    ;(deps as { readBuildChannel: unknown }).readBuildChannel = () => "dev"
    ;(deps as { resolveAppPaths: unknown }).resolveAppPaths = (
      input: Parameters<typeof resolveAppPaths>[0],
    ) => {
      calls.resolveAppPaths = [input]
      return resolveAppPaths(input)
    }

    createAppContext(deps)

    expect((calls.resolveAppPaths?.[0] as { appEnv?: string }).appEnv).toBe(
      "development",
    )
    expect(
      (calls.createPlatformKeychainBackend?.[0] as { keychainService?: string })
        .keychainService,
    ).toBe("spectrum-dev")
  })
})

describe("createAppContext draft provider methods", () => {
  it("wires testProviderDraft and listProviderModelsDraft as functions", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.testProviderDraft).toBe("function")
    expect(typeof ctx.listProviderModelsDraft).toBe("function")
  })
})

describe("createAppContext GUI runner extension points", () => {
  it("exposes closeDb as a callable function that closes the underlying SQLite connection", () => {
    // The GUI factory-reset routine (createResetApp) calls `closeDb()` before `rmSync` to release the
    // SQLite file handle. AppContext must surface this seam so the GUI composition layer can wire it
    // without reaching into a private dbClient. Verify it is callable AND that the stub dbClient's
    // connection.close is invoked when it runs.
    let closed = false
    const { deps } = makeFakeDeps()
    ;(deps as { createSqliteClient: unknown }).createSqliteClient = (() => ({
      ok: true,
      value: {
        __stub: "dbClient",
        connection: {
          close: (): void => {
            closed = true
          },
        },
      },
    })) as never
    const ctx = createAppContext(deps)
    expect(typeof ctx.closeDb).toBe("function")
    expect(closed).toBe(false)
    ctx.closeDb()
    expect(closed).toBe(true)
  })

  it("exposes clock as a Clock instance returned by the injected createSystemClock", () => {
    // The runner extension point pattern: the GUI composition layer consumes ctx.clock instead of
    // constructing `{ now: () => new Date() }` inline. The factory must use the injected
    // `createSystemClock` (so tests can swap it for a fixed clock).
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.clock).toBe("object")
    expect(typeof (ctx.clock as { now?: unknown }).now).toBe("function")
    expect((ctx.clock as { now: () => Date }).now()).toBeInstanceOf(Date)
  })
})

describe("createAppContext native run path wiring", () => {
  it("builds the run store from the shared db client + a clock", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)
    const args = calls.createRunStore?.[0] as { db?: unknown; clock?: unknown }
    expect(args?.db).toEqual({ __stub: "dbClient" })
    expect(args?.clock).toBeDefined()
  })

  it("exposes runEvents.read as a function for replay", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.runEvents.read).toBe("function")
  })

  it("registers claude as native (it routes to the shared ACP driver)", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(ctx.driverRegistry.isNative("claude" as never)).toBe(true)
  })

  it("registers codex as native (it routes to the shared ACP driver)", () => {
    const ctx = createAppContext(makeFakeDeps().deps)
    expect(ctx.driverRegistry.isNative("codex" as never)).toBe(true)
  })

  it("registers opencode as native (it routes to the shared ACP driver)", () => {
    const ctx = createAppContext(makeFakeDeps().deps)
    expect(ctx.driverRegistry.isNative("opencode" as never)).toBe(true)
  })

  it("registers openclaw as native (it routes to the shared ACP driver)", () => {
    const ctx = createAppContext(makeFakeDeps().deps)
    expect(ctx.driverRegistry.isNative("openclaw" as never)).toBe(true)
  })

  it("does not register the demo harness as native when the demo flag is off", () => {
    const ctx = createAppContext(makeFakeDeps().deps)
    expect(ctx.driverRegistry.isNative("demo" as never)).toBe(false)
  })

  it("still registers the ACP harnesses as native when the demo flag is off", () => {
    const ctx = createAppContext({
      ...makeFakeDeps().deps,
      demoHarnessEnabled: false,
    })
    expect(ctx.driverRegistry.isNative("claude" as never)).toBe(true)
    expect(ctx.driverRegistry.isNative("demo" as never)).toBe(false)
  })

  it("makes the demo harness launchable AND native when the demo flag is set (both registries agree)", async () => {
    // The bug this guards: the demo *driver* was registered but no demo *harness* was listed, so the
    // native view was unreachable. With the flag on, the harness registry must LIST `demo` (so the New
    // Session modal offers it) AND the driver registry must mark it native (so it routes to RunDetail).
    const deps: CreateAppContextDeps = {
      ...makeFakeDeps().deps,
      demoHarnessEnabled: true,
      // a real-ish base registry so the withDemoHarness decorator can append to its list
      createRegistry: (() => ({
        list: async () => ok([claude]),
        add: async () => ok(undefined),
        remove: async () => ok(undefined),
      })) as never,
    }
    const ctx = createAppContext(deps)
    const listed = await ctx.registry.list()
    const ids = listed.ok ? listed.value.map((h) => h.id) : []
    expect(ids).toContain("demo" as HarnessId)
    expect(ids).toContain("claude" as HarnessId)
    expect(ctx.driverRegistry.isNative("demo" as never)).toBe(true)
  })
})

describe("createAppContext resolveModelEnv wiring", () => {
  it("re-renders a proxied env for an in-session model pick", async () => {
    // The runtime-core factory exposes `resolveModelEnv` directly on the returned context (it's a
    // base AppContext runner-extension point). Call it directly with a real harness/model pair and
    // assert the env is proxied.
    const { deps } = makeFakeDeps()

    // Override createPathCommandResolver to return a fake that resolves "claude".
    // The fake maps "claude" -> "/usr/local/bin/claude" (absolute so guard passes). It does NOT
    // map claude's ACP shim (`claude-code-acp`): resolveModelEnv needs only the rendered env, so a
    // missing shim binary must not strip it and leave the session unrouted.
    ;(
      deps as { createPathCommandResolver: unknown }
    ).createPathCommandResolver = () =>
      createFakeCommandResolver({ claude: "/usr/local/bin/claude" }, "linux")

    // Override createRegistry to return a real in-memory registry (builtins only, including claude).
    ;(deps as { createRegistry: unknown }).createRegistry = () =>
      createRegistry({
        fileSource: createInMemoryHarnessFileSource([]),
      })

    // Override createFileRuntimeState to return an in-memory runtime state with a known key.
    const runtimeState = createInMemoryRuntimeState()
    await runtimeState.writeProxyKey("test-proxy-key-abc")
    ;(deps as { createFileRuntimeState: unknown }).createFileRuntimeState =
      () => runtimeState

    // Override createCachedConfigStore to return a config with known proxyHost.
    // NOTE: proxyPort in config is no longer the source for resolveModelEnv — the composition-level
    // effective port (defaultConfig().settings.proxyPort + channelProxyPortOffset(channel)) is used
    // instead. For the stable channel (readBuildChannel returns undefined → stable), offset=0, so
    // effective port = 4000.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [
              {
                id: "p1",
                name: "Local",
                sdkProvider: "openai",
                config: {},
                secrets: {},
                models: ["gpt-4o"],
              },
            ],
            models: [
              { id: "mdl_default", providerId: "p1", providerModel: "gpt-4o" },
            ],
            settings: { proxyPort: 9999, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)

    const env = await ctx.resolveModelEnv({
      harnessId: "claude" as import("@spectrum/types").HarnessId,
      modelId: "mdl_default" as import("@spectrum/types").ModelId,
    })

    // The host comes from config (127.0.0.1); the port comes from the effective composition-level
    // proxyPort (defaultConfig base=4000 + stable offset=0 = 4000), NOT from cfg.settings.proxyPort.
    expect(env.ANTHROPIC_BASE_URL).toContain("127.0.0.1")
    expect(env.ANTHROPIC_BASE_URL).toContain("4000")
    expect(env.ANTHROPIC_MODEL).toBe("mdl_default")
  })

  it("returns {} when the harnessId is not registered", async () => {
    const { deps } = makeFakeDeps()

    // Provide a minimal config store so createAppContext can call .load() without error.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [],
            models: [],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    // Provide a minimal registry so resolveModelEnv can call registry.list() without error.
    // list() returns an empty harness list so any harnessId lookup finds nothing → returns {}.
    ;(deps as { createRegistry: unknown }).createRegistry = () => ({
      list: async () => ok([]),
      add: async () => ok(undefined),
      remove: async () => ok(undefined),
    })

    const ctx = createAppContext(deps)

    const env = await ctx.resolveModelEnv({
      harnessId: "not-a-real-harness" as import("@spectrum/types").HarnessId,
      modelId: "mdl_any" as import("@spectrum/types").ModelId,
    })

    expect(env).toEqual({})
  })

  it("returns {} (direct) when resolveModelEnv is called with a null modelId", async () => {
    const { deps } = makeFakeDeps()

    // Provide a minimal config store so createAppContext can call .load() without error.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [],
            models: [],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)

    const env = await ctx.resolveModelEnv({
      harnessId: "claude" as import("@spectrum/types").HarnessId,
      modelId: null,
    })

    expect(env).toEqual({})
  })

  it("resolveModelEnv uses the effective (channel-offset) proxy port for canary", async () => {
    // A canary build should route resolveModelEnv through port 4001 (base 4000 + offset 1)
    const { deps } = makeFakeDeps()

    // Set the build channel to canary
    ;(deps as { readBuildChannel: unknown }).readBuildChannel = () => "canary"

    // Override createPathCommandResolver to return a fake that resolves "claude".
    ;(
      deps as { createPathCommandResolver: unknown }
    ).createPathCommandResolver = () =>
      createFakeCommandResolver({ claude: "/usr/local/bin/claude" }, "linux")

    // Override createRegistry to return a real in-memory registry (builtins only, including claude).
    ;(deps as { createRegistry: unknown }).createRegistry = () =>
      createRegistry({
        fileSource: createInMemoryHarnessFileSource([]),
      })

    // Override createFileRuntimeState to return an in-memory runtime state with a known key.
    const runtimeState = createInMemoryRuntimeState()
    await runtimeState.writeProxyKey("test-proxy-key-abc")
    ;(deps as { createFileRuntimeState: unknown }).createFileRuntimeState =
      () => runtimeState

    // Config with base proxyPort = 4000; effective port for canary = 4001
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providers: [
              {
                id: "p1",
                name: "Local",
                sdkProvider: "openai",
                config: {},
                secrets: {},
                models: ["gpt-4o"],
              },
            ],
            models: [
              { id: "mdl_default", providerId: "p1", providerModel: "gpt-4o" },
            ],
            settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
          }),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)

    const env = await ctx.resolveModelEnv({
      harnessId: "claude" as import("@spectrum/types").HarnessId,
      modelId: "mdl_default" as import("@spectrum/types").ModelId,
    })

    // Canary channel: base 4000 + offset 1 = effective port 4001
    expect(env.ANTHROPIC_BASE_URL).toContain("4001")
    expect(env.ANTHROPIC_BASE_URL).not.toContain("4000")
  })
})

describe("createAppContext ACP driver wiring", () => {
  it("constructs the ACP driver via deps.createAcpDriver", () => {
    let acpCalled = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => {
      acpCalled = true
      return { start: () => ok({}) }
    }) as never
    createAppContext(deps)
    expect(acpCalled).toBe(true)
  })

  it("routingDriver.start dispatches to the native driver by default (no behavior change)", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(typeof ctx.routingDriver.start).toBe("function")
  })

  it("routes openclaw to the ACP driver (Phase 2 — completes the UNVERIFIED driver)", () => {
    let acpStartCalled = false
    let nativeStartCalled = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => ({
      start: () => {
        acpStartCalled = true
        return ok({}) as never
      },
    })) as never
    ;(deps as { createFakeDriver: unknown }).createFakeDriver = (() => ({
      start: () => {
        nativeStartCalled = true
        return ok({}) as never
      },
    })) as never
    const ctx = createAppContext(deps)
    ctx.routingDriver.start({
      harnessId: "openclaw" as never,
      cwd: "/tmp",
      env: {},
    })
    expect(acpStartCalled).toBe(true)
    expect(nativeStartCalled).toBe(false)
  })

  it("routes opencode to the ACP driver (native ACP agent)", () => {
    let acpStartCalled = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => ({
      start: () => {
        acpStartCalled = true
        return ok({}) as never
      },
    })) as never
    const ctx = createAppContext(deps)
    ctx.routingDriver.start({
      harnessId: "opencode" as never,
      cwd: "/tmp",
      env: {},
    })
    expect(acpStartCalled).toBe(true)
  })

  it("routes claude to the ACP driver", () => {
    let acpStartCalled = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => ({
      start: () => {
        acpStartCalled = true
        return ok({}) as never
      },
    })) as never
    const ctx = createAppContext(deps)
    ctx.routingDriver.start({
      harnessId: "claude" as never,
      cwd: "/tmp",
      env: {},
    })
    expect(acpStartCalled).toBe(true)
  })

  it("routes codex to the ACP driver", () => {
    let acpStartCalled = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => ({
      start: () => {
        acpStartCalled = true
        return ok({}) as never
      },
    })) as never
    const ctx = createAppContext(deps)
    ctx.routingDriver.start({
      harnessId: "codex" as never,
      cwd: "/tmp",
      env: {},
    })
    expect(acpStartCalled).toBe(true)
  })

  it("reports ACP-routed harnesses as native so the GUI can launch them", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(ctx.driverRegistry.isNative("claude" as HarnessId)).toBe(true)
    expect(ctx.driverRegistry.isNative("codex" as HarnessId)).toBe(true)
    expect(ctx.driverRegistry.isNative("opencode" as HarnessId)).toBe(true)
    expect(ctx.driverRegistry.isNative("openclaw" as HarnessId)).toBe(true)
  })

  it("routes a newly added ACP harness with no composition-root change", () => {
    // The whole point of the migration: adding an ACP agent is a harness definition, not a driver.
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(ctx.driverRegistry.isNative("gemini" as HarnessId)).toBe(true)
  })

  it("does not report an unknown harness as native", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    expect(ctx.driverRegistry.isNative("nope" as HarnessId)).toBe(false)
  })

  it("resolves the ACP driver from the registry for an ACP harness", () => {
    let started = false
    const { deps } = makeFakeDeps()
    ;(deps as { createAcpDriver: unknown }).createAcpDriver = (() => ({
      start: () => {
        started = true
        return ok({}) as never
      },
    })) as never
    const ctx = createAppContext(deps)
    ctx.driverRegistry.get("claude" as HarnessId)?.start({
      harnessId: "claude" as HarnessId,
      cwd: "/tmp",
      env: {},
    })
    expect(started).toBe(true)
  })
})
