import { describe, expect, it } from "bun:test"
import type { CreateAppContextDeps } from "./deps"
import { realDeps } from "./deps"

describe("CreateAppContextDeps", () => {
  it("realDeps provides every shared seam", () => {
    const keys = Object.keys(
      realDeps,
    ) as readonly (keyof CreateAppContextDeps)[]
    for (const required of [
      "homeDir",
      "platform",
      "env",
      "resolveAppPaths",
      "ensureDir",
      "migrateLegacyMacosConfig",
      "migrateLaunchkitToSpectrum",
      "migrateProductionToCanary",
      "createFsConfigFile",
      "createFileConfigStore",
      "createCachedConfigStore",
      "createPlatformKeychainBackend",
      "createSecretFileOps",
      "secretPassphrase",
      "createBunProcessRunner",
      "createCryptoIdGen",
      "createSecretStore",
      "createSqliteClient",
      "runMigrations",
      "createSystemClock",
      "createSessionStore",
      "createProjectStore",
      "createRegistry",
      "createPathCommandResolver",
      "createBunProcessSpawner",
      "launchHarness",
      "createProviderFactory",
      "loadSdk",
      "createRealGateway",
      "createFileRuntimeState",
      "createRunStore",
      "createFakeDriver",
      "createAcpDriver",
      "createDataAdmin",
      "demoHarnessEnabled",
      "genProxyKey",
      "readBuildChannel",
    ] as const) {
      expect(keys, `missing seam ${required}`).toContain(required)
    }
  })

  it("realDeps omits GUI-only seams", () => {
    const keys = Object.keys(realDeps)
    expect(keys).not.toContain("createRunManager")
    expect(keys).not.toContain("startRunnerSocket")
    expect(keys).not.toContain("createRendererWatchdog")
    expect(keys).not.toContain("removeDir")
    expect(keys).not.toContain("relaunch")
  })
})
