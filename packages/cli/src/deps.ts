import type { Config, ConfigStore } from "@launchkit/config"
import type { LaunchParams } from "@launchkit/harnesses"
import type { RunningProxy } from "@launchkit/proxy"
import type { SecretStore } from "@launchkit/secrets"
import type { SessionStore } from "@launchkit/sessions"
import type { HarnessDefinition } from "@launchkit/types"
import type { Result } from "@launchkit/utils"
import type { Writer } from "./writer"

/** Options the CLI passes to `proxy.start` for an ephemeral launch-time proxy. */
export type StartProxyDeps = {
  readonly host: string
  readonly port: number
  readonly proxyKey: string
  readonly config: Config
}

/**
 * Everything a command needs, injected. Each field is an interface owned by another
 * package (or a tiny function seam), so commands stay pure and fully fakeable.
 *
 * - `registry.list()` mirrors `HarnessRegistry.list()` from `@launchkit/harnesses`.
 * - `launch` is `launchHarness(deps)` already partially applied by the app shell — a
 *   single call `(params) => Result<{ pid }, unknown>`.
 * - `proxy.start` returns the `RunningProxy` from `@launchkit/proxy`; `proxy.isRunning`
 *   wraps `isProxyRunning(baseUrl)`.
 * - `genProxyKey` mints the per-run ≥32-byte proxy key (security.md). Its value reaches
 *   the harness env via `launch` only — never the `Writer`.
 */
export type CliDeps = {
  readonly config: ConfigStore
  readonly secrets: SecretStore
  readonly registry: {
    list(): Promise<Result<readonly HarnessDefinition[], unknown>>
  }
  readonly launch: (
    params: LaunchParams,
  ) => Result<{ readonly pid: number }, unknown>
  readonly proxy: {
    isRunning(baseUrl: string): Promise<boolean>
    start(opts: StartProxyDeps): RunningProxy
  }
  readonly sessions: SessionStore
  readonly out: Writer
  readonly genProxyKey: () => string
}
