import type { ConfigStore } from "@launchkit/config"
import type { SecretStore } from "@launchkit/secrets"
import type { SessionStore } from "@launchkit/sessions"
import type { LaunchParams, HarnessRegistry } from "@launchkit/harnesses"
import type { ProviderFactory, LanguageModelGateway, RunningProxy } from "@launchkit/proxy"
import type { Result } from "@launchkit/utils"

/** Result of testing one provider's live connectivity (mirrors ipc TestProviderResult). */
export type ProviderTestResult = { readonly ok: boolean; readonly latencyMs: number }

/**
 * The wired subsystems — every effectful capability the GUI/CLI needs, already constructed with
 * real adapters by `createAppContext`. The IPC handlers and `main.ts` depend on this shape; tests
 * inject a fake. Keeping it an explicit type (not inferred from the factory) lets desktop-shell-02
 * write handlers against it before the factory exists.
 */
export interface AppContext {
  readonly config: ConfigStore
  readonly secrets: SecretStore
  readonly sessions: SessionStore
  readonly registry: HarnessRegistry
  /** `launchHarness(realDeps)` partially applied — a single `(params) => Result<{ pid }, unknown>`. */
  readonly launch: (params: LaunchParams) => Result<{ readonly pid: number }, unknown>
  readonly proxy: {
    isRunning(baseUrl: string): Promise<boolean>
    start(opts: { host: string; port: number; proxyKey: string; config: import("@launchkit/config").Config }): RunningProxy
  }
  readonly factory: ProviderFactory
  readonly gateway: LanguageModelGateway
  /** Test one provider's connectivity. The real implementation is provided by the tray-and-polish plan. */
  readonly testProvider: (providerId: string) => Promise<Result<ProviderTestResult, unknown>>
  /** The configured proxy port (from `config.settings.proxyPort`), surfaced for `getProxyStatus`. */
  readonly proxyPort: number
  /** The loopback proxy base URL (`http://127.0.0.1:<port>`), used by `proxy.isRunning`. */
  readonly proxyBaseUrl: string
  /** Mints the per-run >=32-byte proxy key (security.md) when the shell starts an ephemeral proxy. */
  readonly genProxyKey: () => string
  /** Resolved settings paths (config + db + harness dir), surfaced for diagnostics/tests. */
  readonly paths: { readonly configFile: string; readonly dbFile: string; readonly harnessDir: string }
}
