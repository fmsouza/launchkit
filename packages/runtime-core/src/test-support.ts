import { mkdirSync } from "node:fs"
import { homedir } from "node:os"

import { createFakeDriver } from "@spectrum/agent-driver"
import {
  createCachedConfigStore,
  createFileConfigStore,
  createFsConfigFile,
  defaultConfig,
} from "@spectrum/config"
import { createDataAdmin } from "@spectrum/data-admin"
import { createSqliteClient, runMigrations } from "@spectrum/db"
import { createAcpDriver } from "@spectrum/driver-acp"
import {
  createBunCaptureStdout,
  createDirExtensionFileSource,
  createExtensionInstaller,
  createExtensionRegistry,
  createFsDirCopier,
  createFsReadManifest,
  createProcessGitClient,
} from "@spectrum/extensions"
import { createRegistry, launchHarness } from "@spectrum/harnesses"
import { detectPlatform, resolveAppPaths } from "@spectrum/platform"
import {
  createBunProcessSpawner,
  createPathCommandResolver,
} from "@spectrum/proc"
import { createProjectStore } from "@spectrum/projects"
import {
  createCryptoTokenGen,
  createFetchFlowHttp,
  createFetchHealthProbe,
  createFlowClient,
  createFlowRunner,
  createLoopbackPortAllocator,
  createProviderHost,
} from "@spectrum/provider-host"
import { createProviderRegistry } from "@spectrum/providers"
import {
  createFileRuntimeState,
  createProviderFactory,
  createRealGateway,
  loadSdk,
} from "@spectrum/proxy"
import { createRunStore } from "@spectrum/run-store"
import {
  createBunProcessRunner,
  createFsSecretFileOps,
  createPlatformKeychainBackend,
  createSecretStore,
} from "@spectrum/secrets"
import { createSessionStore } from "@spectrum/sessions"
import { createCryptoIdGen, createSystemClock, err, ok } from "@spectrum/utils"
import type { CreateAppContextDeps } from "./deps"
import { migrateProductionToCanary } from "./migrate-canary-data"
import {
  migrateLaunchkitToSpectrum,
  migrateLegacyMacosConfig,
} from "./migrate-legacy-config"

/** Minimal `CreateAppContextDeps` override. All fields are optional; missing fields use a
 * safe default that stubs the constructor so the wiring shape can be exercised without
 * touching real fs/keychain/sqlite. The returned object is suitable for `createAppContext`.
 */
export type FakeAppContextDepsOverrides = Partial<CreateAppContextDeps>

/**
 * Build a `CreateAppContextDeps` whose constructors are inert recording stand-ins — exactly
 * the shape `apps/desktop`'s future `composition-gui.test.ts` (and `apps/cli`'s future tests)
 * will need to construct a real `AppContext` without touching the real fs/keychain/sqlite.
 *
 * Usage:
 * ```ts
 * const deps = buildFakeAppContextDeps({
 *   readBuildChannel: () => "canary",
 *   demoHarnessEnabled: true,
 * })
 * const ctx = createAppContext(deps)
 * ```
 *
 * Each constructor records its call args in a `calls` field on the returned object so tests
 * can assert wiring shape. The returned `deps` is a real `CreateAppContextDeps` — pass it
 * straight to `createAppContext`.
 */
export const buildFakeAppContextDeps = (
  overrides: FakeAppContextDepsOverrides = {},
): CreateAppContextDeps & {
  readonly calls: Record<string, readonly unknown[]>
} => {
  const calls: Record<string, unknown[]> = {}
  const record =
    (name: string) =>
    (...args: unknown[]): unknown => {
      calls[name] = args
      return { __stub: name }
    }

  // All constructor fields are deliberately typed as `unknown` returning functions; the
  // `as never` casts below are intentional — the resulting object satisfies
  // `CreateAppContextDeps` at runtime, and tests assert via the `calls` field on the returned
  // object, never by calling the stubs directly. Type-safety here buys nothing and conflicts
  // with the recording pattern.
  const deps = {
    homeDir: overrides.homeDir ?? (() => "/home/tester"),
    platform: overrides.platform ?? "linux",
    env: overrides.env ?? {},
    resolveAppPaths: overrides.resolveAppPaths ?? resolveAppPaths,
    ensureDir:
      overrides.ensureDir ??
      (((dir: string) => {
        calls.ensureDir = [dir]
      }) as never),
    migrateLegacyMacosConfig:
      overrides.migrateLegacyMacosConfig ??
      (record("migrateLegacyMacosConfig") as never),
    migrateLaunchkitToSpectrum:
      overrides.migrateLaunchkitToSpectrum ??
      (record("migrateLaunchkitToSpectrum") as never),
    migrateProductionToCanary:
      overrides.migrateProductionToCanary ??
      (record("migrateProductionToCanary") as never),
    createFsConfigFile:
      overrides.createFsConfigFile ?? (record("createFsConfigFile") as never),
    createFileConfigStore:
      overrides.createFileConfigStore ??
      (record("createFileConfigStore") as never),
    // Shaped, not `record(...)`: the composition root loads config during its initial
    // extension refresh, so the stub needs a real `load`/`save`.
    createCachedConfigStore:
      overrides.createCachedConfigStore ??
      (((...a: unknown[]) => {
        calls.createCachedConfigStore = a
        return {
          load: async () => ok(defaultConfig()),
          save: async () => ok(undefined),
        }
      }) as never),
    createPlatformKeychainBackend:
      overrides.createPlatformKeychainBackend ??
      (record("createPlatformKeychainBackend") as never),
    createSecretFileOps:
      overrides.createSecretFileOps ?? (record("createSecretFileOps") as never),
    secretPassphrase: overrides.secretPassphrase ?? (async () => null),
    createBunProcessRunner:
      overrides.createBunProcessRunner ??
      (record("createBunProcessRunner") as never),
    createCryptoIdGen:
      overrides.createCryptoIdGen ?? (record("createCryptoIdGen") as never),
    createSecretStore:
      overrides.createSecretStore ?? (record("createSecretStore") as never),
    createSqliteClient:
      overrides.createSqliteClient ??
      (((path: string) => {
        record("createSqliteClient")(path)
        return { ok: true, value: { __stub: "dbClient" } }
      }) as never),
    runMigrations:
      overrides.runMigrations ??
      (((client: unknown) => {
        record("runMigrations")(client)
        return { ok: true, value: undefined }
      }) as never),
    createSystemClock:
      overrides.createSystemClock ??
      (((..._a: unknown[]) => {
        calls.createSystemClock = _a
        return { now: () => new Date(0) }
      }) as never),
    createSessionStore:
      overrides.createSessionStore ??
      ((() => ({
        create: () => ok(undefined),
        close: () => ok(undefined),
        query: () => ok([]),
        reconcileOrphaned: () => ok(0),
        setResumeId: () => ok(undefined),
        reopen: () => ok(undefined),
        get: () => ok(undefined),
        updateName: () => ok(undefined),
      })) as never),
    createProjectStore: overrides.createProjectStore ?? createProjectStore,
    createRegistry:
      overrides.createRegistry ?? (record("createRegistry") as never),
    createPathCommandResolver:
      overrides.createPathCommandResolver ??
      (record("createPathCommandResolver") as never),
    createBunProcessSpawner:
      overrides.createBunProcessSpawner ??
      (record("createBunProcessSpawner") as never),
    launchHarness:
      overrides.launchHarness ??
      (((..._a: unknown[]) => {
        calls.launchHarness = _a
        return (..._p: unknown[]) => ok({ pid: 1, exited: Promise.resolve(0) })
      }) as never),
    // Shaped, not `record(...)`: the composition root's registry façade calls `get`/`list`/
    // `catalog` straight through to whatever this returns.
    createProviderRegistry:
      overrides.createProviderRegistry ??
      (((...a: unknown[]) => {
        calls.createProviderRegistry = a
        return { get: () => undefined, list: () => [], catalog: () => [] }
      }) as never),
    // Extension/plugin layer: SHAPED stubs, not `record(...)` — the composition root calls
    // methods on the returned objects during its initial refresh, and `{ __stub }` has none.
    createDirExtensionFileSource:
      overrides.createDirExtensionFileSource ??
      (((root: string, linkMap: Readonly<Record<string, string>>) => {
        calls.createDirExtensionFileSource = [root, linkMap]
        return {
          listExtensions: async () => ok([]),
          readExtension: async () => err({ kind: "not-found", id: "none" }),
          removeExtension: async () => ok(undefined),
          extensionDir: (id: string) => `/plugins/${id}`,
        }
      }) as never),
    createExtensionRegistry:
      overrides.createExtensionRegistry ??
      (((...a: unknown[]) => {
        calls.createExtensionRegistry = a
        return {
          list: async () => ok([]),
          providerDescriptors: async () => ok([]),
        }
      }) as never),
    createProviderHost:
      overrides.createProviderHost ??
      (((...a: unknown[]) => {
        calls.createProviderHost = a
        return {
          ensureRunning: async () => err({ kind: "not-found", id: "none" }),
          status: () => "stopped",
          stop: async () => undefined,
          stopAllFor: async () => undefined,
          stopAll: async () => undefined,
          retainOnly: async () => undefined,
        }
      }) as never),
    createProcessGitClient:
      overrides.createProcessGitClient ??
      (record("createProcessGitClient") as never),
    createFsDirCopier:
      overrides.createFsDirCopier ?? (record("createFsDirCopier") as never),
    createFsReadManifest:
      overrides.createFsReadManifest ??
      (record("createFsReadManifest") as never),
    createBunCaptureStdout:
      overrides.createBunCaptureStdout ??
      (record("createBunCaptureStdout") as never),
    createExtensionInstaller:
      overrides.createExtensionInstaller ??
      (((...a: unknown[]) => {
        calls.createExtensionInstaller = a
        return {
          install: async () => err({ kind: "not-found", id: "none" }),
          update: async () => err({ kind: "not-found", id: "none" }),
          remove: async () => ok(undefined),
        }
      }) as never),
    createLoopbackPortAllocator:
      overrides.createLoopbackPortAllocator ??
      (record("createLoopbackPortAllocator") as never),
    createFetchHealthProbe:
      overrides.createFetchHealthProbe ??
      (record("createFetchHealthProbe") as never),
    createCryptoTokenGen:
      overrides.createCryptoTokenGen ??
      (record("createCryptoTokenGen") as never),
    createFetchFlowHttp:
      overrides.createFetchFlowHttp ?? (record("createFetchFlowHttp") as never),
    createFlowClient:
      overrides.createFlowClient ?? (record("createFlowClient") as never),
    // Shaped, not `record(...)`: the composition root's retention sweep calls
    // `activeInstanceKeys` and `abandon` on whatever this returns, on every config save and
    // every extension refresh, and `{ __stub }` has neither.
    createFlowRunner:
      overrides.createFlowRunner ??
      (((...a: unknown[]) => {
        calls.createFlowRunner = a
        return {
          start: async () => err({ kind: "not-found", id: "none" }),
          advance: async () => err({ kind: "not-found", id: "none" }),
          takeCompletion: () => undefined,
          cancel: async () => undefined,
          activeInstanceKeys: () => new Set<string>(),
          abandon: () => undefined,
        }
      }) as never),
    createProviderFactory:
      overrides.createProviderFactory ??
      (record("createProviderFactory") as never),
    loadSdk: overrides.loadSdk ?? (async () => ({ create: () => ({}) })),
    createRealGateway:
      overrides.createRealGateway ?? (record("createRealGateway") as never),
    createFileRuntimeState:
      overrides.createFileRuntimeState ??
      (record("createFileRuntimeState") as never),
    createRunStore:
      overrides.createRunStore ??
      ((() => ({ append: () => ok({ seq: 0 }), read: () => ok([]) })) as never),
    createFakeDriver:
      overrides.createFakeDriver ?? (record("createFakeDriver") as never),
    createAcpDriver:
      overrides.createAcpDriver ?? (record("createAcpDriver") as never),
    createDataAdmin:
      overrides.createDataAdmin ?? (record("createDataAdmin") as never),
    createUploadStore:
      overrides.createUploadStore ??
      (((args: { readonly uploadsDir: string }) => {
        calls.createUploadStore = [args]
        return { __stub: "createUploadStore" }
      }) as never),
    demoHarnessEnabled: overrides.demoHarnessEnabled ?? false,
    genProxyKey: overrides.genProxyKey ?? (() => "fixed-test-key"),
    readBuildChannel: overrides.readBuildChannel ?? (() => undefined),
  } as unknown as CreateAppContextDeps

  return { ...deps, calls }
}

// Production-side defaults re-exported so downstream tests can stitch real adapters onto a
// `buildFakeAppContextDeps` override without re-importing each package.
export const realAdapterDefaults: Readonly<Record<string, unknown>> = {
  createFsConfigFile,
  createFileConfigStore,
  createCachedConfigStore,
  createPlatformKeychainBackend,
  createFsSecretFileOps,
  createBunProcessRunner,
  createCryptoIdGen,
  createSecretStore,
  createSqliteClient,
  runMigrations,
  createSystemClock,
  createSessionStore,
  createProjectStore,
  createRegistry,
  createPathCommandResolver,
  createBunProcessSpawner,
  launchHarness,
  createProviderRegistry,
  createDirExtensionFileSource,
  createExtensionRegistry,
  createProviderHost,
  createProcessGitClient,
  createFsDirCopier,
  createFsReadManifest,
  createBunCaptureStdout,
  createExtensionInstaller,
  createLoopbackPortAllocator,
  createFetchHealthProbe,
  createCryptoTokenGen,
  createFetchFlowHttp,
  createFlowClient,
  createFlowRunner,
  createProviderFactory,
  loadSdk,
  createRealGateway,
  createFileRuntimeState,
  createRunStore,
  createFakeDriver,
  createAcpDriver,
  createDataAdmin,
  migrateLegacyMacosConfig,
  migrateLaunchkitToSpectrum,
  migrateProductionToCanary,
  resolveAppPaths,
  detectPlatform,
  ensureDir: (dir: string): void => {
    mkdirSync(dir, { recursive: true })
  },
  homedir,
}
