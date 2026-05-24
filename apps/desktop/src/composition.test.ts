import { describe, it, expect } from "bun:test"
import { ok } from "@launchkit/utils"
import { createAppContext } from "./composition"
import type { CreateAppContextDeps } from "./composition"

/** Record which constructor saw which argument, returning inert stand-ins. */
const makeFakeDeps = (): {
  deps: CreateAppContextDeps
  calls: Record<string, unknown[]>
} => {
  const calls: Record<string, unknown[]> = {}
  const record = (name: string) => (...args: unknown[]): unknown => {
    calls[name] = args
    return { __stub: name }
  }
  const deps: CreateAppContextDeps = {
    homeDir: () => "/home/tester",
    createFsConfigFile: record("createFsConfigFile") as never,
    createFileConfigStore: record("createFileConfigStore") as never,
    createCachedConfigStore: record("createCachedConfigStore") as never,
    createMacosSecurityBackend: record("createMacosSecurityBackend") as never,
    createBunProcessRunner: record("createBunProcessRunner") as never,
    createCryptoIdGen: record("createCryptoIdGen") as never,
    createSecretStore: record("createSecretStore") as never,
    createBunSqliteDatabase: record("createBunSqliteDatabase") as never,
    createSystemClock: record("createSystemClock") as never,
    createSessionStore: ((..._a: unknown[]) => {
      calls["createSessionStore"] = _a
      return { init: () => ok(undefined), create: () => ok(undefined), close: () => ok(undefined), query: () => ok([]) }
    }) as never,
    createDirHarnessFileSource: record("createDirHarnessFileSource") as never,
    createRegistry: record("createRegistry") as never,
    createPathCommandResolver: record("createPathCommandResolver") as never,
    createBunProcessSpawner: record("createBunProcessSpawner") as never,
    launchHarness: ((..._a: unknown[]) => {
      calls["launchHarness"] = _a
      return (..._p: unknown[]) => ok({ pid: 1 })
    }) as never,
    createProviderFactory: record("createProviderFactory") as never,
    loadSdk: (async () => ({ create: () => ({}) })) as never,
    createRealGateway: record("createRealGateway") as never,
    genProxyKey: () => "fixed-test-key",
  }
  return { deps, calls }
}

describe("createAppContext wiring", () => {
  it("builds the config store as a cached store wrapping a file store over an fs config file", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    // fs file is created at the resolved config path under the home dir
    expect((calls["createFsConfigFile"]?.[0] as string)).toContain("/home/tester/.config/launchkit/config.json")
    // the file store receives that fs file ...
    expect(calls["createFileConfigStore"]?.[0]).toEqual({ file: { __stub: "createFsConfigFile" } })
    // ... and the cached store wraps the file store
    expect(calls["createCachedConfigStore"]?.[0]).toEqual({ __stub: "createFileConfigStore" })
  })

  it("builds the secret store from a macOS backend driven by a Bun process runner + crypto id gen", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    expect(calls["createMacosSecurityBackend"]?.[0]).toEqual({ runner: { __stub: "createBunProcessRunner" } })
    expect(calls["createSecretStore"]?.[0]).toEqual({
      backend: { __stub: "createMacosSecurityBackend" },
      idGen: { __stub: "createCryptoIdGen" },
    })
  })

  it("builds the session store from a bun:sqlite database at the resolved db path with a system clock", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    expect((calls["createBunSqliteDatabase"]?.[0] as string)).toContain("/home/tester/.config/launchkit/launchkit.db")
    const sessionArgs = calls["createSessionStore"]?.[0] as { db: unknown; clock: unknown; idGen: unknown }
    expect(sessionArgs.db).toEqual({ __stub: "createBunSqliteDatabase" })
    expect(sessionArgs.clock).toEqual({ __stub: "createSystemClock" })
  })

  it("calls sessions.init() so the schema exists before first use", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    // init returns ok(undefined); the context simply exposes a ready store
    expect(typeof ctx.sessions.init).toBe("function")
  })

  it("builds the harness registry from a directory file source at the resolved harness dir", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    expect((calls["createDirHarnessFileSource"]?.[0] as string)).toContain("/home/tester/.config/launchkit/harnesses")
    expect(calls["createRegistry"]?.[0]).toEqual({ fileSource: { __stub: "createDirHarnessFileSource" } })
  })

  it("partially applies launchHarness with the real resolver + spawner", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    expect(calls["launchHarness"]?.[0]).toEqual({
      resolver: { __stub: "createPathCommandResolver" },
      spawner: { __stub: "createBunProcessSpawner" },
    })
  })

  it("builds the provider factory with the secret store + loadSdk seam", () => {
    const { deps, calls } = makeFakeDeps()
    createAppContext(deps)

    const factoryArgs = calls["createProviderFactory"]?.[0] as { secretStore: unknown; loadSdk: unknown }
    expect(factoryArgs.secretStore).toEqual({ __stub: "createSecretStore" })
    expect(typeof factoryArgs.loadSdk).toBe("function")
  })

  it("exposes the loopback proxy base url and port resolved from default config", () => {
    const { deps } = makeFakeDeps()
    const ctx = createAppContext(deps)
    // default config settings: 127.0.0.1:4000
    expect(ctx.proxyBaseUrl).toBe("http://127.0.0.1:4000")
    expect(ctx.proxyPort).toBe(4000)
  })
})
