import { describe, expect, it } from "bun:test"
import type { Config } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import {
  claude,
  createInMemoryHarnessFileSource,
  createRegistry,
} from "@spectrum/harnesses"
import { resolveAppPaths } from "@spectrum/platform"
import { createFakeCommandResolver } from "@spectrum/proc"
import { createProjectStore } from "@spectrum/projects"
import {
  createInMemoryRuntimeState,
  providerInstanceKey,
} from "@spectrum/proxy"
import { PluginIdSchema, ProviderIdSchema } from "@spectrum/types"
import type { HarnessId } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { createAppContext } from "./create-app-context"
import type { CreateAppContextDeps } from "./deps"
import { buildFakeAppContextDeps } from "./test-support"

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
    // Shaped, not `record(...)`: the composition root loads config during its initial
    // extension refresh, so the stub needs a real `load`/`save`.
    createCachedConfigStore: ((..._a: unknown[]) => {
      calls.createCachedConfigStore = _a
      return {
        load: async () => ok(defaultConfig()),
        save: async () => ok(undefined),
      }
    }) as never,
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
    createProviderRegistry: ((..._a: unknown[]) => {
      calls.createProviderRegistry = _a
      return {
        get: (key: string) =>
          key === "openai" ? ({ key: "openai" } as never) : undefined,
        list: () => [],
        catalog: () => [],
      }
    }) as never,
    // Extension layer: shaped stubs — the composition root calls methods on these during its
    // initial refresh, so `record(...)`'s `{ __stub }` would not do.
    createDirExtensionFileSource: ((
      root: string,
      linkMap: Readonly<Record<string, string>>,
    ) => {
      calls.createDirExtensionFileSource = [root, linkMap]
      return {
        listExtensions: async () => ok([]),
        readExtension: async () => err({ kind: "not-found", id: "none" }),
        removeExtension: async () => ok(undefined),
        extensionDir: (id: string) => `/plugins/${id}`,
      }
    }) as never,
    createExtensionRegistry: ((..._a: unknown[]) => {
      calls.createExtensionRegistry = _a
      return {
        list: async () => ok([]),
        providerDescriptors: async () => ok([]),
      }
    }) as never,
    createProviderHost: ((..._a: unknown[]) => {
      calls.createProviderHost = _a
      return {
        ensureRunning: async () => err({ kind: "not-found", id: "none" }),
        status: () => "stopped",
        stop: async () => undefined,
        stopAllFor: async () => undefined,
        stopAll: async () => undefined,
        retainOnly: async () => undefined,
      }
    }) as never,
    // Extension installer layer: shaped stubs — the composition root constructs the installer
    // (and the git client it takes) during wiring, calling `createProcessGitClient` and
    // `createExtensionInstaller` synchronously, so `record(...)`'s `{ __stub }` would not do
    // for the installer (it must be a real-shaped `ExtensionInstaller`).
    createProcessGitClient: record("createProcessGitClient") as never,
    createFsDirCopier: record("createFsDirCopier") as never,
    createFsReadManifest: record("createFsReadManifest") as never,
    createBunCaptureStdout: record("createBunCaptureStdout") as never,
    createExtensionInstaller: ((..._a: unknown[]) => {
      calls.createExtensionInstaller = _a
      return {
        install: async () => err({ kind: "not-found", id: "none" }),
        update: async () => err({ kind: "not-found", id: "none" }),
        remove: async () => ok(undefined),
      }
    }) as never,
    createLoopbackPortAllocator: record("createLoopbackPortAllocator") as never,
    createFetchHealthProbe: record("createFetchHealthProbe") as never,
    createCryptoTokenGen: record("createCryptoTokenGen") as never,
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
            providerPlugins: [],
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
            providerPlugins: [],
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

  it("injects the shared registry's lookup into listProviderModels (getDescriptor, not the static catalog)", async () => {
    const { deps } = makeFakeDeps()

    // "groq" passes SdkProviderSchema validation but the fake registry (wired above) only
    // claims "openai" — proving listProviderModels resolves through the SAME injected
    // registry as the factory, not a re-derived static lookup.
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () =>
          ok({
            version: 2,
            providerPlugins: [],
            providers: [
              {
                id: "p_groq",
                sdkProvider: "groq",
                label: "Groq",
                models: ["llama3-8b-8192"],
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
    const result = await ctx.listProviderModels("p_groq")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.error as { kind: string }).kind).toBe(
        "unsupported-provider",
      )
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
            providerPlugins: [],
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

  it("builds ONE provider registry via deps.createProviderRegistry and exposes it on the context", () => {
    const { deps, calls } = makeFakeDeps()
    const ctx = createAppContext(deps)

    // Built exactly once — the whole point of Task 7 is a single process-wide registry.
    expect(calls.createProviderRegistry).toBeDefined()
    expect(typeof ctx.providerRegistry.get).toBe("function")
    expect(typeof ctx.providerRegistry.list).toBe("function")
    expect(typeof ctx.providerRegistry.catalog).toBe("function")
  })

  it("keeps resolving through the current registry after refreshExtensions swaps it", async () => {
    // The exposed `providerRegistry` must be a façade over the mutable cell: handing out the
    // cell's VALUE would pin consumers to the builtins-only registry built at construction and
    // silently drop every plugin descriptor a later refresh installs.
    const { deps } = makeFakeDeps()
    const built: string[] = []
    ;(deps as { createProviderRegistry: unknown }).createProviderRegistry =
      () => {
        const tag = `r${built.length + 1}`
        built.push(tag)
        return { get: () => ({ key: tag }), list: () => [], catalog: () => [] }
      }
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () => ok(defaultConfig()),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()

    const latest = built[built.length - 1] ?? ""
    expect(built.length).toBeGreaterThan(1)
    expect((ctx.providerRegistry.get("openai") as { key: string }).key).toBe(
      latest,
    )
  })

  it("builds a usable provider registry from the shared buildFakeAppContextDeps stand-ins", () => {
    // `buildFakeAppContextDeps` is what apps/desktop and apps/cli construct contexts with, and
    // the registry façade calls straight through to whatever its stub returns — so an inert
    // `{ __stub }` there is a TypeError waiting for the first consumer that reads the field.
    const ctx = createAppContext(buildFakeAppContextDeps())
    expect(ctx.providerRegistry.list()).toEqual([])
    expect(ctx.providerRegistry.catalog()).toEqual([])
    expect(ctx.providerRegistry.get("openai")).toBeUndefined()
  })

  it("stops every supervised plugin process when shutdown is called", async () => {
    const { deps } = makeFakeDeps()
    let stopAllCalls = 0
    ;(deps as { createProviderHost: unknown }).createProviderHost = () => ({
      ensureRunning: async () => err({ kind: "not-found", id: "none" }),
      status: () => "stopped",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => {
        stopAllCalls += 1
      },
      retainOnly: async () => undefined,
    })

    const ctx = createAppContext(deps)
    await ctx.shutdown()

    expect(stopAllCalls).toBe(1)
  })

  it("wires the extension installer with the resolved plugin root and the CURRENT config's link map, not an empty one", async () => {
    // Regression pin for the "empty link map bricks every plugin" bug: an installer built once
    // at wiring time with `{}` cannot see already-installed LINKED extensions in its own
    // duplicate-contribution-id gate. `deps.createExtensionInstaller` and
    // `deps.createDirExtensionFileSource` are already recorded by `makeFakeDeps`; this test is
    // the first to actually assert on them.
    const { deps, calls } = makeFakeDeps()
    const linkedInstall = {
      id: PluginIdSchema.parse("linked"),
      source: { kind: "path" as const, path: "/work/linked", linked: true },
      enabled: true,
    }
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore = ((
      ..._a: unknown[]
    ) => {
      calls.createCachedConfigStore = _a
      return {
        load: async () =>
          ok({ ...defaultConfig(), providerPlugins: [linkedInstall] }),
        save: async () => ok(undefined),
      }
    }) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    // The installer fake's `install` fails immediately (see `makeFakeDeps`), so `refresh()` is
    // never reached from inside `install` — `calls.createDirExtensionFileSource` therefore
    // still holds the args the INSTALLER's own construction used, not a later refresh's.
    await ctx.extensions.install({ source: "https://e.com/a.git" })

    const installerArgs = calls.createExtensionInstaller?.[0] as {
      pluginRoot: string
    }
    expect(installerArgs.pluginRoot).toBe(
      "/home/tester/.config/spectrum/providers",
    )

    const fileSourceArgs = calls.createDirExtensionFileSource as unknown as [
      string,
      Record<string, string>,
    ]
    expect(fileSourceArgs[0]).toBe("/home/tester/.config/spectrum/providers")
    expect(fileSourceArgs[1]).toEqual({ linked: "/work/linked" })
  })

  it("propagates a config-load failure out of the extension installer instead of silently falling back to defaultConfig()", async () => {
    // A silent fallback would hand the duplicate-contribution-id gate an EMPTY link map and an
    // empty `existingInstalls()` on a transient read failure — the gate disabling itself rather
    // than refusing. `createCachedConfigStore` does not cache failures, so this read failing
    // does not imply every other config read in the process also fails.
    const { deps, calls } = makeFakeDeps()
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      (() => ({
        load: async () => err({ kind: "parse-failed", detail: "bad json" }),
        save: async () => ok(undefined),
      })) as never

    const ctx = createAppContext(deps)
    const r = await ctx.extensions.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
    // The installer must never even be CONSTRUCTED from a config that failed to load.
    expect(calls.createExtensionInstaller).toBeUndefined()
  })

  it("degrades remove's in-use guard instead of silently succeeding, WARM, after an awaited refresh whose listing never succeeded", async () => {
    // Two LINKED extensions: `bad-plugin`'s manifest fails validation, so `registry.list()`
    // fails the WHOLE batch when it's built from the REAL, config-derived link map (a
    // documented behavior — one broken manifest takes every OTHER extension's `list()` down
    // with it). `good-plugin` is referenced by a configured provider. Before the fix, `remove`'s
    // `in-use` guard read the WIRING-TIME registry instead — built from an EMPTY link map, never
    // swapped because `haveGoodExtensionState` stayed false — whose `list()` sees no directories
    // to iterate (both extensions are linked, so neither lives under the plugin root) and
    // returns a VACUOUS `ok([])`, indistinguishable from "nothing installed". `degraded` came
    // out `false`, the in-use check saw zero contributed keys, and the extension was deleted
    // with `stopAllFor` never called: its children kept running with their secrets.
    const { deps } = makeFakeDeps()
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [
        {
          id: PluginIdSchema.parse("good-plugin"),
          source: { kind: "path", path: "/work/good", linked: true },
          enabled: true,
        },
        {
          id: PluginIdSchema.parse("bad-plugin"),
          source: { kind: "path", path: "/work/bad", linked: true },
          enabled: true,
        },
      ],
      providers: [
        {
          id: ProviderIdSchema.parse("prv_1"),
          name: "Good",
          sdkProvider: "plugin:good-plugin",
          config: {},
          secrets: {},
          models: [],
        },
      ],
    }
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      (() => ({
        load: async () => ok(cfg),
        save: async () => ok(undefined),
      })) as never
    // Tags its return with the link map it was built from, so the registry fake below can tell
    // the WIRING-TIME construction (`{}`) apart from a config-derived one (non-empty) without
    // re-implementing manifest parsing.
    ;(
      deps as { createDirExtensionFileSource: unknown }
    ).createDirExtensionFileSource = ((
      root: string,
      linkMap: Readonly<Record<string, string>>,
    ) => ({
      listExtensions: async () => ok([]),
      readExtension: async () => err({ kind: "not-found", id: "none" }),
      removeExtension: async () => ok(undefined),
      extensionDir: (id: string) => linkMap[id] ?? `${root}/${id}`,
      __linkMap: linkMap,
    })) as never
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      ((registryDeps: {
        fileSource: { __linkMap?: Readonly<Record<string, string>> }
      }) => {
        const isWiringTime =
          Object.keys(registryDeps.fileSource.__linkMap ?? {}).length === 0
        return {
          list: async () =>
            isWiringTime
              ? ok([])
              : err({
                  kind: "unsupported-api-version",
                  apiVersion: "spectrum.dev/v99",
                }),
          providerDescriptors: async () =>
            isWiringTime
              ? ok([])
              : err({
                  kind: "unsupported-api-version",
                  apiVersion: "spectrum.dev/v99",
                }),
        }
      }) as never
    let stopAllCalls = 0
    const stoppedFor: string[] = []
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
      status: () => "stopped",
      stop: async () => {},
      stopAllFor: async (id: string) => {
        stoppedFor.push(id)
      },
      stopAll: async () => {
        stopAllCalls += 1
      },
      retainOnly: async () => {},
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions() // WARM: the refresh is awaited, and it FAILS.

    const r = await ctx.extensions.remove(PluginIdSchema.parse("good-plugin"))
    // Removal still SUCCEEDS on the degraded path (matches the documented degrade-instead-of-
    // refuse behavior) — the bug was never in whether it succeeds, but in whether it stops the
    // right thing on the way.
    expect(r.ok).toBe(true)
    // The fix: a vacuous `ok([])` never distinguishes "nothing installed" from "the real answer
    // is unavailable", so `stopAllFor` (which needs a real contribution list) must NOT be the
    // path taken — the conservative `stopAll()` must fire instead.
    expect(stopAllCalls).toBe(1)
    expect(stoppedFor).toEqual([])
  })

  it("cold-starts ctx.extensionRegistry.list() with the config-derived link map, seeing a linked extension on the very first call", async () => {
    // The public mirror of the installer's cold-start bug: `AppContext.extensionRegistry`
    // delegated straight to `extensionRegistryCell` with no wait, so the FIRST call of a
    // process (before the constructor's own initial refresh resolves) returned the wiring-time
    // registry — `[]`, even with a linked extension installed. Tasks 5/6 (a "list installed
    // extensions" IPC handler and CLI command) would render an empty list on every process's
    // first call.
    const { deps } = makeFakeDeps()
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [
        {
          id: PluginIdSchema.parse("linked"),
          source: { kind: "path", path: "/work/linked", linked: true },
          enabled: true,
        },
      ],
    }
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      (() => ({
        load: async () => ok(cfg),
        save: async () => ok(undefined),
      })) as never
    // The file source fake tags its return value with the link map it was built from, so the
    // registry fake below can tell — without re-implementing manifest parsing — whether IT was
    // built from the config-derived link map (has "linked") or the empty wiring-time one.
    ;(
      deps as { createDirExtensionFileSource: unknown }
    ).createDirExtensionFileSource = ((
      root: string,
      linkMap: Readonly<Record<string, string>>,
    ) => ({
      listExtensions: async () => ok([]),
      readExtension: async () => err({ kind: "not-found", id: "none" }),
      removeExtension: async () => ok(undefined),
      extensionDir: (id: string) => linkMap[id] ?? `${root}/${id}`,
      __linkMap: linkMap,
    })) as never
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      ((registryDeps: {
        fileSource: { __linkMap?: Readonly<Record<string, string>> }
      }) => ({
        list: async () =>
          ok(
            Object.entries(registryDeps.fileSource.__linkMap ?? {}).map(
              ([id, dir]) => ({
                manifest: {
                  apiVersion: "spectrum.dev/v1",
                  id,
                  name: id,
                  version: "1.0.0",
                  contributes: { providers: [] },
                },
                ignoredContributions: [],
                dir,
              }),
            ),
          ),
        providerDescriptors: async () => ok([]),
      })) as never

    const ctx = createAppContext(deps)
    // Deliberately NO `await ctx.refreshExtensions()` — the whole point is the FIRST call.
    const listed = await ctx.extensionRegistry.list()
    expect(listed.ok).toBe(true)
    if (listed.ok)
      expect(listed.value.map((e) => String(e.manifest.id))).toEqual(["linked"])
  })

  it("continues with builtins only when the extension registry fails to list", async () => {
    // A broken manifest must not take startup down: the refresh logs and falls back.
    const { deps } = makeFakeDeps()
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      () => ({
        list: async () => err({ kind: "invalid-manifest", detail: "boom" }),
        providerDescriptors: async () =>
          err({ kind: "invalid-manifest", detail: "boom" }),
      })
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      () => ({
        load: async () => ok(defaultConfig()),
        save: async () => ok(undefined),
      })

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()

    expect(typeof ctx.providerRegistry.get).toBe("function")
    expect(ctx.providerRegistry.list()).toEqual([])
  })

  it("injects the registry's lookup as getDescriptor into the provider factory", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    const factoryArgs = calls.createProviderFactory?.[0] as {
      getDescriptor: (key: string) => unknown
    }
    expect(typeof factoryArgs.getDescriptor).toBe("function")
    expect(factoryArgs.getDescriptor("openai")).toEqual({ key: "openai" })
    expect(factoryArgs.getDescriptor("nonexistent")).toBeUndefined()
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
            providerPlugins: [],
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
            providerPlugins: [],
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
            providerPlugins: [],
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
            providerPlugins: [],
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

/**
 * The base-url resolver the composition root injects into the provider factory. It is the single
 * point where a plugin-contributed provider's traffic is aimed, so every branch is asserted here
 * through the recorded `createProviderFactory` argument.
 */
describe("createAppContext resolveBaseUrl", () => {
  type ResolveResult = {
    readonly ok: boolean
    readonly value?: unknown
    readonly error?: { readonly kind: string; readonly detail?: string }
  }
  type Resolve = (input: {
    descriptor: unknown
    config: Readonly<Record<string, string>>
    secrets: Readonly<Record<string, string>>
    instanceKey: string | undefined
  }) => Promise<ResolveResult>

  const resolveOf = (calls: Record<string, unknown[]>): Resolve =>
    (calls.createProviderFactory?.[0] as { resolveBaseUrl: Resolve })
      .resolveBaseUrl

  /** A gate a test can hold a refresh open on. */
  const makeGate = (): { wait: Promise<void>; open: () => void } => {
    let open = (): void => {}
    const wait = new Promise<void>((resolve) => {
      open = () => {
        resolve()
      }
    })
    return { wait, open }
  }

  /** A LoadedExtension-shaped record; `launch` present ⇒ Spectrum supervises the contribution. */
  const extension = (id: string, supervised: boolean): unknown => ({
    manifest: {
      id,
      contributes: {
        providers: [
          {
            id,
            transport: {
              kind: "http",
              wire: "openai",
              ...(supervised
                ? { launch: { command: "srv", args: [], envTemplate: {} } }
                : {}),
            },
          },
        ],
      },
    },
    ignoredContributions: [],
    dir: `/plugins/${id}`,
  })

  /** A plugin descriptor: no `defaultBaseUrl`, exactly as `descriptorFromContribution` builds. */
  const pluginDescriptor = (id: string): unknown => ({
    key: `plugin:${id}`,
    sdkMapping: { baseUrlOption: "baseURL", apiKey: { kind: "option" } },
  })

  /**
   * Mark extensions enabled in the live config. `enabledIds` comes ONLY from
   * `cfg.providerPlugins`, so an installed-but-not-enabled extension is not supervised.
   */
  const withEnabledPlugins = (
    deps: CreateAppContextDeps,
    ids: readonly string[],
  ): void => {
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      (() => ({
        load: async () =>
          ok({
            ...defaultConfig(),
            providerPlugins: ids.map((id) => ({
              id,
              source: { kind: "local" },
              enabled: true,
            })),
          }),
        save: async () => ok(undefined),
      })) as never
  }

  /** Wire an extension registry whose `list` reports `extensions` (optionally behind a gate). */
  const withExtensions = (
    deps: CreateAppContextDeps,
    extensions: () => readonly unknown[],
    gate?: () => Promise<void> | undefined,
  ): void => {
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      (() => ({
        list: async () => {
          const held = gate?.()
          if (held !== undefined) await held
          return ok(extensions())
        },
        providerDescriptors: async () => ok([]),
      })) as never
  }

  it("resolves a supervised extension to the live loopback url from the provider host", async () => {
    const { deps, calls } = makeFakeDeps()
    withEnabledPlugins(deps, ["acme"])
    withExtensions(deps, () => [extension("acme", true)])
    const seen: unknown[] = []
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async (input: unknown) => {
        seen.push(input)
        return ok({ baseUrl: "http://127.0.0.1:45001", pid: 7 })
      },
      status: () => "running",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: { apiKey: "k" },
      instanceKey: "inst-1",
    })

    expect(r.ok && r.value).toBe("http://127.0.0.1:45001")
    expect(seen).toEqual([
      { instanceKey: "inst-1", providerId: "acme", secrets: { apiKey: "k" } },
    ])
  })

  it("never supervises a contribution from an extension that is not enabled", async () => {
    // THE ATTACK: `providerDescriptors` filtered by `enabled`, but the supervised set scanned
    // every installed extension. A disabled extension's launch block was therefore reachable —
    // and it is spawned with the resolved secrets of whichever provider record named its id.
    const { deps, calls } = makeFakeDeps()
    withEnabledPlugins(deps, []) // installed, NOT enabled
    withExtensions(deps, () => [extension("acme", true)])
    let ensureRunningCalls = 0
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => {
        ensureRunningCalls += 1
        return ok({ baseUrl: "http://127.0.0.1:45009", pid: 4 })
      },
      status: () => "running",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: { apiKey: "k" },
      instanceKey: "inst-1",
    })

    expect(ensureRunningCalls).toBe(0)
    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe("bad-request")
  })

  it("refuses the draft-probe path for a supervised extension instead of spawning a process", async () => {
    const { deps, calls } = makeFakeDeps()
    withEnabledPlugins(deps, ["acme"])
    withExtensions(deps, () => [extension("acme", true)])
    let ensureRunningCalls = 0
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => {
        ensureRunningCalls += 1
        return err({ kind: "not-found", id: "acme" })
      },
      status: () => "stopped",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: {},
      instanceKey: undefined,
    })

    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe("bad-request")
    expect(ensureRunningCalls).toBe(0)
  })

  it("reports provider-failed when the supervised extension will not start", async () => {
    const { deps, calls } = makeFakeDeps()
    withEnabledPlugins(deps, ["acme"])
    withExtensions(deps, () => [extension("acme", true)])
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => err({ kind: "spawn-failed", detail: "boom" }),
      status: () => "failed",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: {},
      instanceKey: "inst-1",
    })

    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe("provider-failed")
  })

  it("keeps the serverUrl path for a plugin server Spectrum does not launch", async () => {
    // No `launch` block ⇒ a user-run server: its own `serverUrl` config field still works.
    const { deps, calls } = makeFakeDeps()
    withExtensions(deps, () => [extension("selfrun", false)])

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("selfrun"),
      config: { serverUrl: "http://127.0.0.1:9999" },
      secrets: {},
      instanceKey: "inst-1",
    })

    // undefined ⇒ no override; buildSdkOptions applies config.serverUrl unchanged.
    expect(r.ok).toBe(true)
    expect(r.value).toBeUndefined()
  })

  it("refuses a plugin provider that resolves to no base url at all", async () => {
    // Defence in depth: a plugin descriptor carries no defaultBaseUrl, so falling through with
    // no serverUrl would let the AI SDK aim the request — and the plugin's secrets — at its own
    // cloud endpoint. This guard turns that into a failed request.
    const { deps, calls } = makeFakeDeps()
    withExtensions(deps, () => [extension("acme", false)])

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: {},
      instanceKey: "inst-1",
    })

    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe("bad-request")
  })

  it("leaves a builtin provider on the ordinary serverUrl path", async () => {
    const { deps, calls } = makeFakeDeps()
    withExtensions(deps, () => [])
    let hostTouched = false
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => {
        hostTouched = true
        return err({ kind: "not-found", id: "x" })
      },
      status: () => "stopped",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const r = await resolveOf(calls)({
      descriptor: { key: "openai", sdkMapping: { baseUrlOption: "baseURL" } },
      config: {},
      secrets: {},
      instanceKey: "inst-1",
    })

    expect(r.ok).toBe(true)
    expect(r.value).toBeUndefined()
    expect(hostTouched).toBe(false)
  })

  it("waits for the refresh in flight before routing a supervised provider", async () => {
    // `extensionsReady` must track the LATEST refresh. Pinned to the first one, this request
    // would read the pre-refresh (empty) supervised set and fall through to the guard — the
    // routing bug the atomic-swap work exists to prevent.
    const { deps, calls } = makeFakeDeps()
    const gate = makeGate()
    let installed: readonly unknown[] = []
    let held = false
    withEnabledPlugins(deps, ["acme"])
    withExtensions(
      deps,
      () => installed,
      () => (held ? gate.wait : undefined),
    )
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () =>
        ok({ baseUrl: "http://127.0.0.1:45002", pid: 9 }),
      status: () => "running",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()

    // A second refresh installs the plugin, blocked partway through.
    installed = [extension("acme", true)]
    held = true
    const refresh = ctx.refreshExtensions()
    const pending = resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: {},
      instanceKey: "inst-1",
    })
    gate.open()
    await refresh

    const r = await pending
    expect(r.ok && r.value).toBe("http://127.0.0.1:45002")
  })

  it("never exposes a half-applied extension set while a refresh is in flight", async () => {
    // The three cells swap in ONE synchronous block. Swapping the extension registry before the
    // provider registry (the shape this replaced) publishes a view where a contribution is
    // already gone from one cell and still present in the other.
    const { deps } = makeFakeDeps()
    const gate = makeGate()
    // Signals that the refresh has actually entered its second await — without this the read
    // below would happen before the refresh body ever ran, and observe nothing.
    const parked = makeGate()
    let made = 0
    let held = false
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      (() => {
        made += 1
        const tag = `r${made}`
        return {
          list: async () => ok([extension(tag, false)]),
          providerDescriptors: async () => {
            if (held) {
              parked.open()
              await gate.wait
            }
            return ok([])
          },
        }
      }) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const settled = await ctx.extensionRegistry.list()
    const tagBefore = settled.ok ? settled.value[0]?.manifest.id : undefined

    held = true
    const refresh = ctx.refreshExtensions()
    await parked.wait
    const mid = await ctx.extensionRegistry.list()
    gate.open()
    await refresh
    const done = await ctx.extensionRegistry.list()

    // Mid-flight the PREVIOUS registry is still the published one; only afterwards does the new
    // one become visible.
    const tagMid = mid.ok ? mid.value[0]?.manifest.id : undefined
    const tagDone = done.ok ? done.value[0]?.manifest.id : undefined
    expect(tagMid).toBe(tagBefore)
    expect(tagDone).not.toBe(tagBefore)
  })

  it("keeps the last good extension set when a later refresh fails", async () => {
    // Falling back to builtins is right at STARTUP. On a re-refresh a momentary fs error must
    // not demote a supervised plugin — that is precisely the mis-route the guard above catches.
    const { deps, calls } = makeFakeDeps()
    let failing = false
    withEnabledPlugins(deps, ["acme"])
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      (() => ({
        list: async () =>
          failing
            ? err({ kind: "read-failed", detail: "transient" })
            : ok([extension("acme", true)]),
        providerDescriptors: async () => ok([]),
      })) as never
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () =>
        ok({ baseUrl: "http://127.0.0.1:45003", pid: 3 }),
      status: () => "running",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async () => undefined,
    })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    failing = true
    await ctx.refreshExtensions()

    const r = await resolveOf(calls)({
      descriptor: pluginDescriptor("acme"),
      config: {},
      secrets: {},
      instanceKey: "inst-1",
    })

    expect(r.ok && r.value).toBe("http://127.0.0.1:45003")
  })
})

/**
 * A supervised child is keyed by the provider's CONFIGURATION, so every config edit mints a new
 * key. Nothing retired the old one, so the previous child stayed `running` forever with the old
 * secrets in its environment. Retention is asserted here, at the composition root, because that
 * is the only layer that knows which keys are still backed by a configured provider.
 */
describe("createAppContext supervised instance retention", () => {
  const PLUGIN_KEY = "plugin:acme"

  /** A LoadedExtension whose one contribution declares a launch block. */
  const supervisedExtension = (id: string): unknown => ({
    manifest: {
      id,
      contributes: {
        providers: [
          {
            id,
            transport: {
              kind: "http",
              wire: "openai",
              launch: { command: "srv", args: [], envTemplate: {} },
            },
          },
        ],
      },
    },
    ignoredContributions: [],
    dir: `/plugins/${id}`,
  })

  const configWith = (
    providerConfig: Record<string, string>,
    enabled = true,
  ): unknown => ({
    ...defaultConfig(),
    providerPlugins: [{ id: "acme", source: { kind: "local" }, enabled }],
    providers: [
      {
        id: "p_acme",
        name: "Acme",
        sdkProvider: PLUGIN_KEY,
        models: ["m"],
        config: providerConfig,
        secrets: { apiKey: { ref: "kc_1" } },
      },
    ],
  })

  const keyFor = (providerConfig: Record<string, string>): string =>
    providerInstanceKey({
      sdkProvider: PLUGIN_KEY,
      config: providerConfig,
      secretRefs: { apiKey: { ref: "kc_1" } },
    })

  /** Wires a config store over a mutable cell and a provider host that records retention. */
  const wire = (
    deps: CreateAppContextDeps,
    initial: Record<string, string>,
  ): { retained: Array<readonly string[]> } => {
    let current = configWith(initial)
    ;(deps as { createCachedConfigStore: unknown }).createCachedConfigStore =
      (() => ({
        load: async () => ok(current),
        save: async (next: unknown) => {
          current = next
          return ok(undefined)
        },
      })) as never
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      (() => ({
        list: async () => ok([supervisedExtension("acme")]),
        providerDescriptors: async () => ok([]),
      })) as never
    const retained: Array<readonly string[]> = []
    ;(deps as { createProviderHost: unknown }).createProviderHost = (() => ({
      ensureRunning: async () => err({ kind: "not-found", id: "acme" }),
      status: () => "stopped",
      stop: async () => undefined,
      stopAllFor: async () => undefined,
      stopAll: async () => undefined,
      retainOnly: async (keys: ReadonlySet<string>) => {
        retained.push([...keys])
      },
    })) as never
    return { retained }
  }

  it("retains exactly the instance key of the configured supervised provider on refresh", async () => {
    const { deps } = makeFakeDeps()
    const { retained } = wire(deps, { region: "eu" })

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()

    expect(retained.at(-1)).toEqual([keyFor({ region: "eu" })])
  })

  it("retires the previous child's instance key when the provider's config changes", async () => {
    const { deps } = makeFakeDeps()
    const { retained } = wire(deps, { region: "eu" })

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    const before = keyFor({ region: "eu" })
    expect(retained.at(-1)).toEqual([before])

    const saved = await ctx.config.save(configWith({ region: "us" }) as never)
    expect(saved.ok).toBe(true)

    const after = keyFor({ region: "us" })
    expect(after).not.toBe(before)
    // The retired key is absent from the retention set, so its child is stopped rather than
    // left running with the old secrets.
    expect(retained.at(-1)).toEqual([after])
  })

  it("retires a supervised child when its extension is disabled by a config save", async () => {
    // Disabling a plugin in the GUI is a `config.save`, not a refresh, so the sweep cannot read
    // the supervised set alone — that set is only recomputed by `refreshExtensions`. Without
    // consulting the enabled ids of the config BEING SAVED, the key stays retained and the
    // child keeps running with its secrets: exactly the leak this sweep exists to close.
    const { deps } = makeFakeDeps()
    const { retained } = wire(deps, { region: "eu" })

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    expect(retained.at(-1)).toEqual([keyFor({ region: "eu" })])

    const saved = await ctx.config.save(
      configWith({ region: "eu" }, false) as never,
    )
    expect(saved.ok).toBe(true)

    expect(retained.at(-1)).toEqual([])
  })

  it("retires a supervised child whose extension a refresh dropped", async () => {
    const { deps } = makeFakeDeps()
    const { retained } = wire(deps, { region: "eu" })
    let installed: readonly unknown[] = [supervisedExtension("acme")]
    ;(deps as { createExtensionRegistry: unknown }).createExtensionRegistry =
      (() => ({
        list: async () => ok(installed),
        providerDescriptors: async () => ok([]),
      })) as never

    const ctx = createAppContext(deps)
    await ctx.refreshExtensions()
    expect(retained.at(-1)).toEqual([keyFor({ region: "eu" })])

    installed = []
    await ctx.refreshExtensions()

    expect(retained.at(-1)).toEqual([])
  })
})
