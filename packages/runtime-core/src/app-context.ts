import type {
  AgentDriver,
  RunLaunchInput,
  RunManagerDeps,
  SessionSink,
} from "@spectrum/agent-driver"
import type { StoredEvent } from "@spectrum/agent-events"
import type { Config, ConfigStore } from "@spectrum/config"
import type { DataAdmin } from "@spectrum/data-admin"
import type {
  HarnessError,
  HarnessRegistry,
  LaunchParams,
  ResolvedHarnessLaunch,
} from "@spectrum/harnesses"
import type { Logger } from "@spectrum/logger"
import type { ProjectStore } from "@spectrum/projects"
import type { ProviderRegistry } from "@spectrum/providers"
import type {
  LanguageModelGateway,
  ProviderFactory,
  RunningProxy,
  RuntimeState,
} from "@spectrum/proxy"
import type { RunStore } from "@spectrum/run-store"
import type { SecretStore } from "@spectrum/secrets"
import type { SessionStore } from "@spectrum/sessions"
import type {
  DiscoveredModel,
  HarnessId,
  ModelId,
  SdkProvider,
  SessionId,
} from "@spectrum/types"
import type { Clock, Result } from "@spectrum/utils"
import type { DriverRegistry } from "./driver-registry"
import type { UploadStore } from "./upload-store"

/** Result of testing one provider's live connectivity (mirrors ipc TestProviderResult). */
export type ProviderTestResult = {
  readonly ok: boolean
  readonly latencyMs: number
}

/**
 * The wired subsystems — every effectful capability the GUI/CLI needs, already constructed with
 * real adapters by `createAppContext`. The IPC handlers and `main.ts` depend on this shape; tests
 * inject a fake. Keeping it an explicit type (not inferred from the factory) lets desktop-shell-02
 * write handlers against it before the factory exists.
 *
 * This is the BASE shape shared by `apps/cli` and `apps/desktop`. GUI-only fields
 * (`runner`, `runnerSocketUrl`, `rendererWatchdog`, `resetApp`, `pickFolder`, `openExternalUrl`,
 * `updater`) are NOT here — they live on `createGuiContext`'s extension in apps/desktop.
 * Runner extension points (`sessionSink`, `runStore`, `routingDriver`, `resolveResumeInput`,
 * `resolveModelEnv`) ARE on the base so `createAppContext` can wire them once and both runtimes
 * can carry them; the CLI ignores them, the GUI consumes them.
 */
export interface AppContext {
  readonly config: ConfigStore
  readonly secrets: SecretStore
  readonly sessions: SessionStore
  readonly projects: ProjectStore
  readonly registry: HarnessRegistry
  /** `launchHarness(realDeps)` partially applied — a single `(params) => Result<{ pid, exited }, unknown>`. */
  readonly launch: (
    params: LaunchParams,
  ) => Result<
    { readonly pid: number; readonly exited: Promise<number> },
    unknown
  >
  /**
   * `resolveHarnessLaunch({ resolver })` partially applied: resolves a harness's command + renders
   * its proxy env WITHOUT spawning. The GUI native-run path uses this (then hands the result to
   * `ctx.runner.launch`); the headless `ctx.launch` keeps owning the CLI spawn path.
   */
  readonly resolveLaunch: (
    params: LaunchParams,
  ) => Result<ResolvedHarnessLaunch, HarnessError>
  readonly proxy: {
    isRunning(baseUrl: string): Promise<boolean>
    start(opts: {
      host: string
      port: number
      proxyKey: string
      config: Config
    }): RunningProxy
  }
  readonly factory: ProviderFactory
  readonly gateway: LanguageModelGateway
  /**
   * The ONE process-wide provider registry (builtins now, builtins ⊕ installed plugins in
   * Plan 2). `factory`, the model listers, and the proxy's `getDescriptor` all resolve through
   * this same instance — never re-derived. Surfaced here so `apps/desktop` can reach it too
   * (config-form validation, catalog listing).
   */
  readonly providerRegistry: ProviderRegistry
  /**
   * Persists the GUI proxy's per-run key so the CLI `launch` can reuse it (avoiding a
   * mismatched key the running proxy would reject). Holds only the per-run token — never a secret.
   */
  readonly runtime: RuntimeState
  /** Test one provider's connectivity. The real implementation is provided by the tray-and-polish plan. */
  readonly testProvider: (
    providerId: string,
  ) => Promise<Result<ProviderTestResult, unknown>>
  /**
   * Discover the live model list for a provider: look up the provider in config, resolve its apiKey
   * from the keychain (keyless providers such as ollama pass apiKey=undefined), then call the proxy
   * ModelLister. SECURITY: the apiKey is resolved server-side and used only for the outbound request;
   * it never crosses to the view.
   */
  readonly listProviderModels: (
    providerId: string,
  ) => Promise<Result<readonly DiscoveredModel[], unknown>>
  /** Probe connectivity for an UN-SAVED provider from inline config + secret VALUES. */
  readonly testProviderDraft: (input: {
    sdkProvider: SdkProvider
    config: Readonly<Record<string, string>>
    secrets: Readonly<Record<string, string>>
    providerModel: string
  }) => Promise<Result<ProviderTestResult, unknown>>
  /** Discover models for an UN-SAVED provider from inline config + secret VALUES. */
  readonly listProviderModelsDraft: (input: {
    sdkProvider: SdkProvider
    config: Readonly<Record<string, string>>
    secrets: Readonly<Record<string, string>>
  }) => Promise<Result<readonly DiscoveredModel[], unknown>>
  /** The configured proxy port (from `config.settings.proxyPort`), surfaced for `getProxyStatus`. */
  readonly proxyPort: number
  /** The loopback proxy base URL (`http://127.0.0.1:<port>`), used by `proxy.isRunning`. */
  readonly proxyBaseUrl: string
  /** Mints the per-run >=32-byte proxy key (security.md) when the shell starts an ephemeral proxy. */
  readonly genProxyKey: () => string
  /**
   * The proxy token a harness session presents: `<masterKey>.<base64url(modelId)>`. The proxy decodes
   * the model id and routes any non-exact request (sub-agents, background, review) to it.
   */
  readonly mintSessionProxyKey: (modelId: string) => Promise<string>
  /** Read a session's stored canonical event log for read-only replay. */
  readonly runEvents: {
    read(
      id: SessionId,
    ): Result<
      readonly StoredEvent[],
      { readonly kind: "db-failed"; readonly detail: string }
    >
  }
  /**
   * Re-resolve a persisted session's env/command/args from its harness + model. Shared with
   * `resolveResumeInput` (RunManager's resume path) so the launch handler and the manager's
   * resume path produce byte-identical inputs. ModelId present ⇒ proxied (mint a per-session
   * proxy key + render harness env/args templates); absent ⇒ direct. SECURITY: never logs the
   * proxy key or the rendered env.
   */
  readonly resolveLaunchInput: (input: {
    readonly harnessId: HarnessId
    readonly modelId?: ModelId
    readonly cwd: string
  }) => Promise<RunLaunchInput>
  /** Transactional cascade deletes for sessions and projects. */
  readonly dataAdmin: DataAdmin
  /** Which harnesses have a registered native driver (every launchable harness does). */
  readonly driverRegistry: DriverRegistry
  /** Structured application logger (console + rotating file). Inject child scopes into subsystems. */
  readonly log: Logger
  /**
   * Resolved settings paths (config + db + harness dir), surfaced for diagnostics/tests.
   * `dataDir` is exposed so GUI seams (e.g. createResetApp) can read it from the shared context.
   */
  readonly paths: {
    readonly configFile: string
    readonly dbFile: string
    readonly harnessDir: string
    readonly dataDir: string
    readonly uploadsDir: string
  }
  /**
   * Content-addressed upload store: copy a file from a native picker temp path into
   * `paths.uploadsDir` (idempotent — same content ⇒ same sha256 id, no double-copy);
   * expose the result as an `AttachmentRef` for the run-event path. The real
   * implementation lives in `apps/desktop/src/upload-store-fs.ts`; the runtime-core
   * default is a no-op stub (every save returns `io-failed`).
   */
  readonly uploadStore: UploadStore
  /**
   * Legacy data dirs the GUI's factory reset (`createResetApp`) cleans up alongside `dataDir`.
   * Computed by `createAppContext` from `legacyMacosConfigDir(homeDir)` + `legacyLaunchkitDataDir(...)`
   * (both from `@spectrum/platform`). Surfaced here so `createGuiContext` can hand them to
   * `createResetApp` without re-deriving or re-importing the migration helpers.
   */
  readonly legacyDirs: readonly string[]
  /**
   * GUI runner extension points — typed + documented so `createGuiContext` (apps/desktop) can
   * compose the RunManager WITHOUT re-deriving these. The CLI never reads them.
   */
  /** SessionSink the GUI RunManager writes started/ended sessions through. */
  readonly sessionSink: SessionSink
  /** RunStore the GUI RunManager persists canonical events to. */
  readonly runStore: RunStore
  /** AgentDriver that routes start() to the registered driver for a harness. */
  readonly routingDriver: AgentDriver
  /** Re-resolve a persisted session's env for the RunManager's resume path. */
  readonly resolveResumeInput: NonNullable<RunManagerDeps["resolveResumeInput"]>
  /** Re-render a session's proxied route env when the user picks a model in-session. */
  readonly resolveModelEnv: NonNullable<RunManagerDeps["resolveModelEnv"]>
  /**
   * GUI factory-reset hook: explicitly close the SQLite handle before rmSync. The resetApp
   * routine (`createResetApp` in apps/desktop) calls this before `removeDir(dataDir)` so the file
   * handle is released on every OS, not just ones where rmSync tolerates an open fd.
   */
  readonly closeDb: () => void
  /**
   * GUI runner extension point: the injectable Clock the RunManager reads from. Surfaced here so
   * `createGuiContext` can hand it to the RunManager without re-deriving `{ now: () => new Date() }`
   * inline — that broke the injectable seam (tests could no longer fake the clock from the GUI
   * composition layer).
   */
  readonly clock: Clock
}
