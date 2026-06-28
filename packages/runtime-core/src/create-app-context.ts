import { join } from "node:path"

import type { ConfigStore } from "@spectrum/config"
import type {
  LanguageModelGateway,
  ProviderFactory,
  RunningProxy,
} from "@spectrum/proxy"
import type { SecretStore } from "@spectrum/secrets"
import type { HarnessId, ModelId, SessionId } from "@spectrum/types"

import type {
  AgentDriver,
  RunLaunchInput,
  RunManagerDeps,
  SessionSink,
} from "@spectrum/agent-driver"
import { demoScript } from "@spectrum/agent-driver"
import { ThinkingEffortSchema } from "@spectrum/agent-events"
import { defaultConfig } from "@spectrum/config"
import { createClaudeDriver } from "@spectrum/driver-claude"
import { createOpenclawDriver } from "@spectrum/driver-openclaw"
import {
  createInMemoryHarnessFileSource,
  resolveHarnessLaunch,
} from "@spectrum/harnesses"
import {
  createConsoleSink,
  createFsLogFileOps,
  createLogger,
  createRotatingFileSink,
  resolveMinLevel,
} from "@spectrum/logger"
import {
  channelProxyPortOffset,
  legacyLaunchkitDataDir,
  legacyMacosConfigDir,
  resolveAppEnv,
  resolveChannel,
} from "@spectrum/platform"
import { getDescriptor } from "@spectrum/providers"
import {
  createDraftProviderTester,
  createFetchHttpGet,
  createModelLister,
  createProviderTester,
  createRouter,
  encodeSessionProxyKey,
  isProxyRunning,
  resolveTimeouts,
  startProxy,
} from "@spectrum/proxy"
import { err, redactSecrets } from "@spectrum/utils"
import type { AppContext } from "./app-context"
import { withDemoHarness } from "./demo-harness"
import { type CreateAppContextDeps, realDeps } from "./deps"
import {
  DEMO_HARNESS_ID,
  type DriverRegistry,
  createDriverRegistry,
} from "./driver-registry"
import {
  createSecretRegistry,
  withRuntimeKeyRegistration,
  withSecretRegistration,
} from "./secret-registry"

/**
 * Build the `testProvider` function that delegates to `@spectrum/proxy`'s
 * `createProviderTester`. Resolves the provider from the live config, picks its
 * first model (falling back to the provider id), and measures connectivity with
 * the already-wired factory + gateway. Extracted so Biome's noUnusedImports
 * rule sees the `err` / `createProviderTester` usage at module scope.
 */
const createTestProvider = (
  config: ConfigStore,
  factory: ProviderFactory,
  gateway: LanguageModelGateway,
  createSystemClock: () => import("@spectrum/utils").Clock,
): AppContext["testProvider"] => {
  return async (providerId) => {
    const loaded = await config.load()
    if (!loaded.ok) return loaded
    const provider = loaded.value.providers.find(
      (p) => String(p.id) === providerId,
    )
    if (provider === undefined)
      return err({ kind: "unknown-provider", providerId })
    const providerModel = provider.models[0] ?? providerId
    const providerTester = createProviderTester({
      factory,
      gateway,
      clock: createSystemClock(),
    })
    return providerTester(provider, providerModel)
  }
}

/**
 * Build the `listProviderModels` function that delegates to `@spectrum/proxy`'s
 * `createModelLister`. Resolves the provider from the live config, resolves its apiKey
 * from the keychain (keyless providers like ollama have no secrets — apiKey stays undefined),
 * then calls the lister. The ModelLister is constructed once and closed over.
 * SECURITY: apiKey is resolved from the keychain and passed only to the outbound HTTP request;
 * it is never returned to the view.
 */
const createListProviderModels = (
  config: ConfigStore,
  secrets: SecretStore,
): AppContext["listProviderModels"] => {
  const lister = createModelLister({ httpGet: createFetchHttpGet() })
  return async (providerId) => {
    const loaded = await config.load()
    if (!loaded.ok) return loaded
    const provider = loaded.value.providers.find(
      (p) => String(p.id) === providerId,
    )
    if (provider === undefined)
      return err({ kind: "unknown-provider", providerId })

    // Resolve the apiKey from the keychain. Providers without secrets (e.g. ollama) have an
    // empty secrets record, so apiKey stays undefined — the lister handles that gracefully.
    let apiKey: string | undefined
    const apiKeyRef = provider.secrets.apiKey
    if (apiKeyRef !== undefined) {
      const got = await secrets.get(apiKeyRef)
      if (!got.ok) return got
      apiKey = got.value
    }

    return lister({
      sdkProvider: provider.sdkProvider,
      config: provider.config,
      ...(apiKey !== undefined ? { apiKey } : {}),
    })
  }
}

/**
 * Draft tester: probe inline values (no config load, no keychain).
 * SECURITY: secret VALUES are inline (caller-supplied, never persisted); used only to build a
 * one-shot probe model and never logged.
 */
const createTestProviderDraft = (
  factory: ProviderFactory,
  gateway: LanguageModelGateway,
  createSystemClock: () => import("@spectrum/utils").Clock,
): AppContext["testProviderDraft"] => {
  return async ({ sdkProvider, config, secrets, providerModel }) => {
    const tester = createDraftProviderTester({
      factory,
      gateway,
      clock: createSystemClock(),
    })
    return tester({ sdkProvider, config, secrets, providerModel })
  }
}

/**
 * Draft model discovery: list models from inline values (no config load, no keychain).
 * SECURITY: apiKey is the inline, caller-supplied value (never from the keychain); it is passed
 * only to the outbound discovery request and is never persisted or logged.
 */
const createListProviderModelsDraft =
  (): AppContext["listProviderModelsDraft"] => {
    const lister = createModelLister({ httpGet: createFetchHttpGet() })
    return async ({ sdkProvider, config, secrets }) => {
      const apiKey = secrets.apiKey
      return lister({
        sdkProvider,
        config,
        ...(apiKey !== undefined ? { apiKey } : {}),
      })
    }
  }

/**
 * Construct the real adapters and inject them into the wired `AppContext`. FLAT and logic-free:
 * every line is a `create*` call wiring one dependency into the next — no branching, no IO logic
 * (that lives in the injected, separately-tested functions). Shared between `apps/cli` and
 * `apps/desktop`: GUI-only fields (`runner`, `runnerSocketUrl`, `rendererWatchdog`, `resetApp`,
 * `pickFolder`, `openExternalUrl`, `updater`) live in `apps/desktop`'s `createGuiContext`, not here.
 * Runner extension points (`sessionSink`, `runStore`, `routingDriver`, `resolveResumeInput`,
 * `resolveModelEnv`) are wired here so `createGuiContext` can hand them to the RunManager
 * without re-deriving — the CLI ignores them.
 */
export const createAppContext = (
  deps: CreateAppContextDeps = realDeps,
): AppContext => {
  const buildChannel = deps.readBuildChannel()
  const appEnv = resolveAppEnv({ buildChannel, env: deps.env })
  const channel = resolveChannel({ buildChannel, env: deps.env })

  // Legacy data lived only under the production dirs; never migrate it into a dev sandbox.
  if (appEnv === "production") {
    deps.migrateLegacyMacosConfig({
      platform: deps.platform,
      homeDir: deps.homeDir(),
      env: deps.env,
    })
    deps.migrateLaunchkitToSpectrum({
      platform: deps.platform,
      homeDir: deps.homeDir(),
      env: deps.env,
    })
  }
  // One-time seed: copy the production data dir into the canary dir on first canary run so the user
  // keeps their providers/models/sessions. The OS keychain stays shared, so copied secret refs
  // resolve. No-op once the canary dir exists. Must run BEFORE ensureDir/db-open.
  if (channel === "canary") {
    deps.migrateProductionToCanary({
      platform: deps.platform,
      homeDir: deps.homeDir(),
      env: deps.env,
    })
  }
  const paths = deps.resolveAppPaths({
    platform: deps.platform,
    homeDir: deps.homeDir(),
    env: deps.env,
    appEnv,
    channel,
  })
  const configFile = paths.configFile
  const dbFile = paths.dbFile
  const harnessDir = paths.harnessDir
  const runtimeFile = paths.runtimeFile
  const dataDir = paths.dataDir

  // A fresh install has no data directory yet. Create it BEFORE opening the SQLite DB — otherwise
  // `new Database(dbFile)` throws ("unable to open database file") on the missing parent, which
  // crashes GUI startup before the proxy ever binds (the config/secret stores only mkdir lazily on
  // their first write, which is too late for the db opened here). This is the only startup step that
  // needs the dir to pre-exist.
  deps.ensureDir(dataDir)

  // Defense-in-depth secret registry (spec §6): fed at the secret chokepoints (resolved/written
  // apiKeys via the wrapped secrets store; the minted per-run proxy key below) and read lazily by
  // the logger's `redact` so no record can persist a known secret value.
  const secretRegistry = createSecretRegistry()

  // Wrap the minted per-run proxy key so each value is registered for redaction (it does NOT flow
  // through the secret store, so it must be registered here).
  const genProxyKey = (): string => {
    const key = deps.genProxyKey()
    secretRegistry.register(key)
    return key
  }

  // runtime is declared early so `mintSessionProxyKey` (below) can read the persisted proxy key
  // before the logger/config are wired. Wrapped so a key RESTORED from persisted state
  // (cross-process / GUI-restart reuse) — not just a freshly minted one — is also registered for
  // redaction, closing that path symmetrically.
  const runtime = withRuntimeKeyRegistration(
    deps.createFileRuntimeState(runtimeFile),
    secretRegistry,
  )

  // Session-encoded proxy token: <masterKey>.<base64url(modelId)>. The proxy decodes the model id
  // and routes any non-exact request (sub-agents, background, review) to it.
  // SECURITY: never log the returned token — it contains the master proxy key.
  const mintSessionProxyKey = async (modelId: string): Promise<string> => {
    const masterKey = (await runtime.readProxyKey()) ?? genProxyKey()
    return encodeSessionProxyKey(masterKey, modelId)
  }

  const log = createLogger({
    sinks: [
      createConsoleSink({
        write: (line) => {
          process.stderr.write(line)
        },
        pretty: appEnv === "development",
      }),
      createRotatingFileSink({
        fileOps: createFsLogFileOps(),
        dir: join(dataDir, "logs"),
        maxBytes: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
    clock: deps.createSystemClock(),
    minLevel: resolveMinLevel(appEnv, deps.env),
    // Defense-in-depth (spec §6): scrub any in-process secret (the per-run proxy key,
    // resolved apiKeys) from every record at log time. Call sites must still never pass
    // raw secrets as fields — this is the backstop, especially for webview-forwarded records.
    redact: (text) => redactSecrets(text, secretRegistry.snapshot()),
  })

  log.info("resolved app environment", {
    appEnv,
    buildChannel: buildChannel ?? "none",
  })

  // config: cached( file( fs(configFile) ) ). Wrapped to keep a synchronous snapshot of the latest
  // config (`liveConfig`) updated on every load/save, so the long-running GUI proxy can resolve
  // against live provider/model changes without an app restart. (The cached store already refreshes
  // its own cache on save; this just exposes that latest value synchronously to the proxy router.)
  const baseConfig = deps.createCachedConfigStore(
    deps.createFileConfigStore({
      file: deps.createFsConfigFile(configFile),
      logger: log.child("config"),
    }),
  )
  let liveConfig: import("@spectrum/config").Config | undefined
  const config: ConfigStore = {
    load: async () => {
      const loaded = await baseConfig.load()
      if (loaded.ok) liveConfig = loaded.value
      return loaded
    },
    save: async (next) => {
      const saved = await baseConfig.save(next)
      if (saved.ok) liveConfig = next
      return saved
    },
  }

  // secrets: store( per-OS keychain backend (security / secret-tool / DPAPI-file) over a Bun runner )
  const keychainService = appEnv === "development" ? "spectrum-dev" : "spectrum"
  const secrets = withSecretRegistration(
    deps.createSecretStore({
      backend: deps.createPlatformKeychainBackend({
        platform: deps.platform,
        runner: deps.createBunProcessRunner(),
        fileOps: deps.createSecretFileOps(),
        secretsDir: paths.secretsDir,
        secretPassphrase: deps.secretPassphrase,
        keychainService,
      }),
      idGen: deps.createCryptoIdGen(),
      logger: log.child("secrets"),
    }),
    secretRegistry,
  )

  // sessions: open sqlite at dbFile, apply migrations, then build the store.
  const dbOpen = deps.createSqliteClient(dbFile, { logger: log.child("db") })
  if (!dbOpen.ok) {
    throw new Error(
      `failed to open database at ${dbFile}: ${dbOpen.error.detail}`,
    )
  }
  const dbClient = dbOpen.value
  const migrated = deps.runMigrations(dbClient, { logger: log.child("db") })
  if (!migrated.ok) {
    throw new Error(`failed to migrate database: ${migrated.error.detail}`)
  }
  const sessions = deps.createSessionStore({
    db: dbClient,
    clock: deps.createSystemClock(),
    idGen: deps.createCryptoIdGen(),
  })

  const projects = deps.createProjectStore({
    db: dbClient,
    clock: deps.createSystemClock(),
    idGen: deps.createCryptoIdGen(),
  })

  // Every launched session must belong to a project. Resolve (or create) the project from the
  // launch cwd, then create the session with its projectId. This is the single GUI orchestration
  // seam — SessionStore.create stays pure (it just receives a projectId).
  const sessionSink: SessionSink = {
    create: (input) => {
      const cwd = input.cwd ?? ""
      const project = projects.findOrCreateByPath(cwd)
      if (!project.ok)
        return err({
          kind: "db-failed",
          detail:
            project.error.kind === "invalid-path"
              ? "a working directory is required"
              : project.error.detail,
        })
      return sessions.create({
        harnessId: input.harnessId,
        projectId: project.value.id,
        cwd,
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
    },
    close: sessions.close,
    updateName: (id, name) => sessions.updateName(id, name),
    // Session-resume ports (Task 4: setResumeId/reopen/get): the RunManager invokes these to persist
    // a harness-native resume token, revive an ended session, and re-resolve its row for resume.
    setResumeId: (id, resumeId) => sessions.setResumeId(id, resumeId),
    reopen: (id) => sessions.reopen(id),
    get: (id) => sessions.get(id),
  }

  // harnesses: registry of the builtins only (custom user harnesses are no longer supported, so the
  // file source is empty); launcher partially applied with real adapters.
  const baseRegistry = deps.createRegistry({
    fileSource: createInMemoryHarnessFileSource([]),
  })
  // Dev-only (SPECTRUM_DEMO_HARNESS=1): surface a launchable `demo` harness — driven by the FakeDriver
  // registered in the driver registry below — so the native conversation view is reachable from the New
  // Session modal. Production (flag unset) lists only the builtin harnesses.
  const registry = deps.demoHarnessEnabled
    ? withDemoHarness(baseRegistry)
    : baseRegistry
  // ONE resolver shared by both launch paths: the headless `launch` (CLI spawn) and the GUI's
  // `resolveLaunch` (resolve command + render proxy env, then hand to `runner.launch`).
  const resolver = deps.createPathCommandResolver()
  const launch = deps.launchHarness({
    resolver,
    spawner: deps.createBunProcessSpawner(),
    logger: log.child("harness"),
  })
  const resolveLaunch = resolveHarnessLaunch({ resolver })

  // proxy provider layer: factory (secrets + lazy SDK loader) + real streamText gateway
  const factory = deps.createProviderFactory({
    secretStore: secrets,
    loadSdk: deps.loadSdk,
  })
  const gateway = deps.createRealGateway({
    getTimeouts: (ctx) => {
      const s = (liveConfig ?? defaultConfig()).settings
      const windows = {
        firstTokenTimeoutMs: s.firstTokenTimeoutMs,
        interTokenTimeoutMs: s.interTokenTimeoutMs,
      }
      return ctx === undefined
        ? windows
        : resolveTimeouts(getDescriptor(ctx.sdkProvider).streaming, windows)
    },
  })

  // Native run path: structured canonical events persisted to the shared db. The RunStore
  // structurally satisfies the RunManager's RunEventSink; sessionSink structurally satisfies its
  // SessionSink. Both are surfaced as runner extension points on AppContext.
  const runStore = deps.createRunStore({
    db: dbClient,
    clock: deps.createSystemClock(),
  })

  // Native drivers: `claude`, `codex`, `opencode`, `openclaw` all launch native via their drivers
  // (openclaw is UNVERIFIED — no binary). The demo FakeDriver stays dev-gated
  // (SPECTRUM_DEMO_HARNESS=1). Each driver injects its own effects so the logic stays unit-testable;
  // the runtime owns the sync↔async bridge + lifecycle.
  //
  // Each per-harness driver receives the same `setResumeId` sink: when the adapter reports its
  // harness-native session id (Claude's `session_id`, Codex's `threadId`) via
  // `ctx.reportResumeToken`, the runtime binds the current Spectrum `sessionId` and calls this
  // sink — which persists via the SessionStore. A failure is logged but never crashes the run:
  // the session simply loses the ability to true-resume (manager still emits a fresh-restart toast).
  const idGen = deps.createCryptoIdGen()
  const driverIdGen = deps.createCryptoIdGen()
  const setResumeIdLog = log.child("runner")
  const setResumeId: (id: SessionId, token: string) => void = (id, token) => {
    const r = sessions.setResumeId(id, token)
    if (!r.ok)
      setResumeIdLog.error("setResumeId failed", {
        sessionId: id,
        kind: r.error.kind,
      })
  }
  const driverRegistry: DriverRegistry = createDriverRegistry({
    claude: createClaudeDriver({
      idGen,
      logger: log.child("driver.claude"),
      setResumeId,
    }),
    codex: deps.createCodexDriver({ idGen: driverIdGen, setResumeId }),
    opencode: deps.createOpencodeDriver({ idGen: driverIdGen, setResumeId }),
    // Plan 4 (UNVERIFIED): OpenClaw gateway driver. No installed binary / published @openclaw/sdk; the
    // real connector throws (→ runner-finished:errored) until wired, but it routes native like the others.
    openclaw: createOpenclawDriver({ idGen, setResumeId }),
    ...(deps.demoHarnessEnabled
      ? { [DEMO_HARNESS_ID]: deps.createFakeDriver({ script: demoScript }) }
      : {}),
  })

  // One AgentDriver for the RunManager: route start() to the registered driver for the harness.
  const routingDriver: AgentDriver = {
    start: (input) => {
      const driver = driverRegistry.get(input.harnessId)
      if (driver === undefined)
        return err({
          kind: "start-failed",
          detail: `no driver for harness ${String(input.harnessId)}`,
        })
      return driver.start(input)
    },
  }

  // Re-render a session's proxied route env when the user picks a model in-session. Mirrors the
  // proxied branch of launchHarness: proxy URL from settings, the running proxy's per-run key from
  // runtime (mint one only as a defensive fallback), env rendered via resolveHarnessLaunch.
  // SECURITY: never log the proxy key or the rendered env.
  const resolveModelEnv = async (input: {
    readonly harnessId: HarnessId
    readonly modelId: ModelId | null
  }): Promise<Readonly<Record<string, string>>> => {
    if (input.modelId === null) return {} // switch to default/subscription ⇒ direct (no proxy env)
    const loaded = await config.load()
    const cfg = loaded.ok ? loaded.value : defaultConfig()
    const listed = await registry.list()
    const harness = listed.ok
      ? listed.value.find((h) => h.id === input.harnessId)
      : undefined
    if (harness === undefined) return {}
    const proxyUrl = `http://${cfg.settings.proxyHost}:${proxyPort}`
    const proxyKey = await mintSessionProxyKey(String(input.modelId))
    const resolved = resolveLaunch({
      harness,
      route: {
        kind: "proxied",
        proxyUrl,
        proxyKey,
        modelId: input.modelId,
      },
    })
    return resolved.ok ? resolved.value.env : {}
  }

  /**
   * Re-resolve a persisted session's env/command/args from its harness + model. Shared by
   * `launchHarness` (via `ctx.resolveLaunchInput`) and the RunManager's resume path
   * (`resolveResumeInput`). Mirrors the env/command/args resolution that `launchHarness` does
   * today in `apps/desktop/src/gui/ipc/handlers.ts`: modelId present ⇒ proxied route (mint a
   * per-session proxy key, render the harness env/args templates); absent ⇒ direct (no proxy
   * env, empty args). SECURITY: never logs the proxy key or the rendered env.
   *
   * On any failure (harness unknown, config load fails, resolver rejects the command) returns a
   * minimal `RunLaunchInput` with `env: {}` — the resume path's `driver.start` failure then
   * surfaces a `runner-finished:errored` rather than throwing from here.
   */
  const resolveLaunchInput = async (input: {
    readonly harnessId: HarnessId
    readonly modelId?: ModelId
    readonly cwd: string
    readonly thinkingEffort?: import("@spectrum/agent-events").ThinkingEffort
  }): Promise<RunLaunchInput> => {
    const listed = await registry.list()
    const harness = listed.ok
      ? listed.value.find((h) => h.id === input.harnessId)
      : undefined
    if (harness === undefined) {
      return {
        harnessId: input.harnessId,
        cwd: input.cwd,
        env: {},
      }
    }
    const loaded = await config.load()
    const cfg = loaded.ok ? loaded.value : defaultConfig()
    const route: import("@spectrum/harnesses").LaunchRoute =
      input.modelId === undefined
        ? { kind: "direct" }
        : {
            kind: "proxied",
            proxyUrl: `http://${cfg.settings.proxyHost}:${proxyPort}`,
            // SECURITY: per-session key encodes the selected model id; never logged.
            proxyKey: await mintSessionProxyKey(String(input.modelId)),
            modelId: input.modelId,
          }
    const resolved = resolveLaunch({ harness, route })
    if (!resolved.ok) {
      return {
        harnessId: input.harnessId,
        cwd: input.cwd,
        env: {},
      }
    }
    return {
      harnessId: input.harnessId,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      cwd: input.cwd,
      env: resolved.value.env,
      command: resolved.value.command,
      args: resolved.value.args,
      ...(input.thinkingEffort !== undefined
        ? { thinkingEffort: input.thinkingEffort }
        : {}),
    }
  }

  const resolveResumeInput: NonNullable<
    RunManagerDeps["resolveResumeInput"]
  > = async (session) => {
    // Read the persisted thinking-effort tier for this harness so resumed sessions
    // start at the same tier the user last selected (mirroring the launchHarness handler).
    const loaded = await config.load()
    const cfg = loaded.ok ? loaded.value : defaultConfig()
    const storedEffort =
      cfg.settings.lastByHarness?.[String(session.harnessId)]?.thinkingEffort
    const parsedEffort =
      storedEffort !== undefined
        ? ThinkingEffortSchema.safeParse(storedEffort)
        : undefined
    const thinkingEffort = parsedEffort?.success ? parsedEffort.data : undefined

    return resolveLaunchInput({
      harnessId: session.harnessId,
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      cwd: session.cwd,
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    })
  }

  // Destructive maintenance + factory reset over the already-wired db/config/secrets. The cascade
  // LOGIC lives in @spectrum/data-admin; here we only construct + inject.
  const dataAdmin = deps.createDataAdmin({ db: dbClient })

  // proxy settings resolved from the default config shape (loopback only, security.md)
  const settings = defaultConfig().settings
  const proxyPort = settings.proxyPort + channelProxyPortOffset(channel)
  const proxyBaseUrl = `http://${settings.proxyHost}:${proxyPort}`

  /**
   * Adapt the CLI/GUI's simplified `{ host, port, proxyKey, config }` start request into the real
   * `startProxy` options: build the model router from the live `config`, and supply the already-wired
   * `factory` + `gateway` + the model list. SECURITY: `host` comes straight from the caller (always
   * `config.settings.proxyHost` = loopback) — never `0.0.0.0`. This is a thin adapter, not branching
   * logic, so the composition root stays effectively flat.
   */
  const startProxyAdapter = (opts: {
    host: string
    port: number
    proxyKey: string
    config: import("@spectrum/config").Config
  }): RunningProxy => {
    // Seed the live snapshot, then resolve against it on EVERY request: a model/provider added or
    // edited in the GUI (persisted via `config.save`, which updates `liveConfig` above) is picked up
    // by the already-running proxy with no restart. Falls back to the start-time config defensively.
    liveConfig = opts.config
    const getConfig = (): import("@spectrum/config").Config =>
      liveConfig ?? opts.config
    return startProxy({
      host: opts.host,
      port: opts.port,
      proxyKey: opts.proxyKey,
      router: createRouter(getConfig),
      factory,
      gateway,
      listModels: () => getConfig().models.map((m) => String(m.id)),
      logger: log.child("proxy"),
    })
  }

  // Legacy data dirs the GUI's factory reset cleans up alongside `dataDir`. Computed once here so
  // `createGuiContext` can hand them to `createResetApp` without re-deriving or re-importing the
  // migration helpers.
  const legacyDirs: readonly string[] = [
    legacyMacosConfigDir(deps.homeDir()),
    legacyLaunchkitDataDir({
      platform: deps.platform,
      homeDir: deps.homeDir(),
      env: deps.env,
    }),
  ]

  return {
    config,
    secrets,
    sessions,
    projects,
    registry,
    launch,
    resolveLaunch,
    resolveLaunchInput,
    proxy: { isRunning: isProxyRunning, start: startProxyAdapter },
    factory,
    gateway,
    runtime,
    testProvider: createTestProvider(config, factory, gateway, () =>
      deps.createSystemClock(),
    ),
    listProviderModels: createListProviderModels(config, secrets),
    testProviderDraft: createTestProviderDraft(factory, gateway, () =>
      deps.createSystemClock(),
    ),
    listProviderModelsDraft: createListProviderModelsDraft(),
    proxyPort,
    proxyBaseUrl,
    genProxyKey,
    mintSessionProxyKey,
    runEvents: { read: runStore.read },
    dataAdmin,
    driverRegistry,
    log,
    paths: { configFile, dbFile, harnessDir, dataDir },
    legacyDirs,
    // Runner extension points (typed + documented on AppContext; the CLI never reads these).
    sessionSink,
    runStore,
    routingDriver,
    resolveResumeInput,
    resolveModelEnv,
    // GUI-only runner extension points (typed + documented on AppContext; the CLI never reads
    // these). `closeDb` lets `createResetApp` release the SQLite file handle before rmSync;
    // `clock` preserves the injectable seam so the GUI composition layer can hand the runner a
    // fake clock in tests instead of constructing `{ now: () => new Date() }` inline.
    closeDb: (): void => {
      dbClient.connection.close()
    },
    clock: deps.createSystemClock(),
  }
}
export type { RunLaunchInput, RunManagerDeps, SessionSink, AgentDriver }
