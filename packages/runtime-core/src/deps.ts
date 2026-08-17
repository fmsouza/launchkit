import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"

// Value-imports: real adapters from each @spectrum/* leaf and node built-ins.
import { createFakeDriver } from "@spectrum/agent-driver"
import {
  createCachedConfigStore,
  createFileConfigStore,
  createFsConfigFile,
} from "@spectrum/config"
import { createDataAdmin } from "@spectrum/data-admin"
import { createSqliteClient, runMigrations } from "@spectrum/db"
import { createAcpDriver } from "@spectrum/driver-acp"
import {
  createDirExtensionFileSource,
  createExtensionRegistry,
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
  createFetchHealthProbe,
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
import { createCryptoIdGen, createSystemClock, err } from "@spectrum/utils"
import { migrateProductionToCanary } from "./migrate-canary-data"
import {
  migrateLaunchkitToSpectrum,
  migrateLegacyMacosConfig,
} from "./migrate-legacy-config"
import type { UploadStore } from "./upload-store"

// `import type` for the Platform constructor type (used via `Platform` directly, not `typeof`).
import type { Platform } from "@spectrum/platform"

/**
 * The constructor functions `createAppContext` wires together. Defaulted to the real adapters from
 * each package; a test injects recording stand-ins to assert the wiring shape without touching real
 * fs/keychain/sqlite. This is the only seam that makes a flat, logic-free composition root testable.
 *
 * GUI-only seams (`createRunManager`, `startRunnerSocket`, `createRendererWatchdog`, `removeDir`,
 * `relaunch`) are NOT here — they live on `CreateGuiContextDeps` in `apps/desktop`, which extends
 * this base at the GUI layer.
 */
export interface CreateAppContextDeps {
  readonly homeDir: typeof homedir
  readonly platform: Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly resolveAppPaths: typeof resolveAppPaths
  /** Create a directory (recursively) — used to materialise the data dir on a fresh install. */
  readonly ensureDir: (dir: string) => void
  readonly migrateLegacyMacosConfig: typeof migrateLegacyMacosConfig
  readonly migrateLaunchkitToSpectrum: typeof migrateLaunchkitToSpectrum
  readonly migrateProductionToCanary: typeof migrateProductionToCanary
  readonly createFsConfigFile: typeof createFsConfigFile
  readonly createFileConfigStore: typeof createFileConfigStore
  readonly createCachedConfigStore: typeof createCachedConfigStore
  readonly createPlatformKeychainBackend: typeof createPlatformKeychainBackend
  readonly createSecretFileOps: typeof createFsSecretFileOps
  readonly secretPassphrase: () => Promise<string | null>
  readonly createBunProcessRunner: typeof createBunProcessRunner
  readonly createCryptoIdGen: typeof createCryptoIdGen
  readonly createSecretStore: typeof createSecretStore
  readonly createSqliteClient: typeof createSqliteClient
  readonly runMigrations: typeof runMigrations
  readonly createSystemClock: typeof createSystemClock
  readonly createSessionStore: typeof createSessionStore
  readonly createProjectStore: typeof createProjectStore
  readonly createRegistry: typeof createRegistry
  readonly createPathCommandResolver: typeof createPathCommandResolver
  readonly createBunProcessSpawner: typeof createBunProcessSpawner
  readonly launchHarness: typeof launchHarness
  /**
   * Build the ONE process-wide provider registry (builtins now, builtins ⊕ installed plugins in
   * Plan 2). `createAppContext` calls this exactly once and threads its `.get` lookup into the
   * factory, the model listers, and the proxy — never re-derives it.
   */
  readonly createProviderRegistry: typeof createProviderRegistry
  /**
   * Provider-plugin (extension) layer. The file source is rebuilt on every refresh because the
   * link map is derived from config; the registry wraps it; the host supervises whatever the
   * registry reports with a `launch` block.
   */
  readonly createDirExtensionFileSource: typeof createDirExtensionFileSource
  readonly createExtensionRegistry: typeof createExtensionRegistry
  readonly createProviderHost: typeof createProviderHost
  readonly createLoopbackPortAllocator: typeof createLoopbackPortAllocator
  readonly createFetchHealthProbe: typeof createFetchHealthProbe
  readonly createCryptoTokenGen: typeof createCryptoTokenGen
  readonly createProviderFactory: typeof createProviderFactory
  readonly loadSdk: typeof loadSdk
  readonly createRealGateway: typeof createRealGateway
  readonly createFileRuntimeState: typeof createFileRuntimeState
  readonly createRunStore: typeof createRunStore
  readonly createFakeDriver: typeof createFakeDriver
  readonly createAcpDriver: typeof createAcpDriver
  readonly createDataAdmin: typeof createDataAdmin
  /** Set in dev to register the demo FakeDriver harness; production leaves it unset. */
  readonly demoHarnessEnabled: boolean
  readonly genProxyKey: () => string
  /**
   * Construct the content-addressed upload store over the resolved `uploadsDir`. The desktop
   * binary overrides this with `createFsUploadStore` (Task 8). The default is an in-memory
   * stub (every save returns `io-failed`) so the CLI / tests can build a context without a
   * writable uploads dir.
   */
  readonly createUploadStore: (deps: {
    readonly uploadsDir: string
  }) => UploadStore
  /**
   * Read the bundled `version.json` channel ("dev" | "stable" | "canary") that pins the
   * app environment. Returns undefined when no bundle is present (CLI binary, tests), in
   * which case the ambient SPECTRUM_ENV is used. Effect: reads a file relative to cwd.
   */
  readonly readBuildChannel: () => string | undefined
}

/** >=32-byte base64url per-run proxy key (security.md). The default for production wiring. */
const defaultGenProxyKey = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

/** Headless passphrase source for the encrypted-file fallback (GUI prompt is a future addition). */
const defaultSecretPassphrase = async (): Promise<string | null> =>
  process.env.SPECTRUM_SECRET_PASSPHRASE ?? null

/**
 * Default upload-store factory: an in-memory stub that fails every save with `io-failed`.
 * The desktop binary overrides this with `createFsUploadStore` (Task 8) in `composition.ts`.
 * Headless consumers (CLI, tests) keep the stub so `createAppContext` is constructable
 * without a writable uploads dir.
 */
const defaultCreateUploadStore = (): UploadStore => ({
  save: async () => err({ kind: "io-failed", detail: "no upload store wired" }),
  saveBytes: async () =>
    err({ kind: "io-failed", detail: "no upload store wired" }),
  readBase64: async () =>
    err({ kind: "not-found", detail: "no upload store wired" }),
  pathOf: async () =>
    err({ kind: "not-found", detail: "no upload store wired" }),
  exists: async () => false,
  size: async () => 0,
})

/** The real constructors, used when `createAppContext()` is called with no argument. */
export const realDeps: CreateAppContextDeps = {
  homeDir: homedir,
  platform: detectPlatform(),
  env: process.env,
  resolveAppPaths,
  ensureDir: (dir: string): void => {
    mkdirSync(dir, { recursive: true })
  },
  migrateLegacyMacosConfig,
  migrateLaunchkitToSpectrum,
  migrateProductionToCanary,
  createFsConfigFile,
  createFileConfigStore,
  createCachedConfigStore,
  createPlatformKeychainBackend,
  createSecretFileOps: createFsSecretFileOps,
  secretPassphrase: defaultSecretPassphrase,
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
  createLoopbackPortAllocator,
  createFetchHealthProbe,
  createCryptoTokenGen,
  createProviderFactory,
  loadSdk,
  createRealGateway,
  createFileRuntimeState,
  createRunStore,
  createFakeDriver,
  createAcpDriver,
  createDataAdmin,
  demoHarnessEnabled: process.env.SPECTRUM_DEMO_HARNESS === "1",
  genProxyKey: defaultGenProxyKey,
  createUploadStore: defaultCreateUploadStore,
  // The host shell (Electrobun bundle) runs the Bun process with cwd =
  // <bundle>/Contents/MacOS, so the app's version.json sits at
  // ../Resources/version.json (same path the GUI updater adapter uses).
  // Any failure (no bundle, unreadable, malformed) yields undefined → ambient-env fallback.
  readBuildChannel: (): string | undefined => {
    try {
      const parsed = JSON.parse(
        readFileSync("../Resources/version.json", "utf8"),
      ) as { channel?: unknown }
      return typeof parsed.channel === "string" ? parsed.channel : undefined
    } catch {
      return undefined
    }
  },
}
