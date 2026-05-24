import { runCli } from "@launchkit/cli"
import type { CliDeps, StartProxyDeps } from "@launchkit/cli"
import { type ProxyHandle, type RunAppDeps, runApp } from "./app"
import { type AppContext, createAppContext } from "./composition"
import { detectMode } from "./detect-mode"
import { openWindow } from "./gui/window"

/** Assemble the CliDeps the CLI runner needs from a wired AppContext. */
const cliDepsFrom = (ctx: AppContext): CliDeps => ({
  config: ctx.config,
  secrets: ctx.secrets,
  sessions: ctx.sessions,
  registry: ctx.registry,
  launch: ctx.launch,
  proxy: {
    isRunning: ctx.proxy.isRunning,
    start: (opts: StartProxyDeps) =>
      ctx.proxy.start({
        host: opts.host,
        port: opts.port,
        proxyKey: opts.proxyKey,
        config: opts.config,
      }),
  },
  genProxyKey: ctx.genProxyKey,
  out: {
    write: (line: string): void => {
      process.stdout.write(`${line}\n`)
    },
  },
})

/**
 * Build the `RunAppDeps` the mode router needs, wiring the real subsystems via `createAppContext`.
 * Exported (and parameterized by the factory + optional overrides) so it is unit-testable without
 * constructing real adapters or importing Electrobun at top level.
 *
 * SECURITY: the GUI proxy is started bound to loopback from `config.settings.proxyHost` via
 * `ctx.proxy.start(...)`, with a freshly generated per-run key — never `0.0.0.0`.
 */
export const buildRealDeps = (
  makeContext: typeof createAppContext,
  overrides: Partial<RunAppDeps> = {},
): RunAppDeps => {
  const ctx = makeContext()
  return {
    runCli: overrides.runCli ?? ((argv) => runCli(cliDepsFrom(ctx))(argv)),
    startProxy:
      overrides.startProxy ??
      ((): ProxyHandle => {
        // Load the live config so the GUI proxy's router knows the real providers + aliases.
        // A fresh install loads defaults (empty providers/aliases) — still loopback + valid.
        let stop = (): void => {}
        void ctx.config.load().then((loaded) => {
          if (!loaded.ok) return
          const running = ctx.proxy.start({
            host: loaded.value.settings.proxyHost,
            port: loaded.value.settings.proxyPort,
            proxyKey: ctx.genProxyKey(),
            config: loaded.value,
          })
          stop = running.stop
        })
        return { stop: () => stop() }
      }),
    openWindow: overrides.openWindow ?? ((): void => openWindow(ctx)),
  }
}

// --- entry point ---------------------------------------------------------------------
// The single side effect: detect the mode and run it. Everything above is pure/exported.
// Guarded with import.meta.main so tests can import { buildRealDeps } without triggering
// the real entry point.
if (import.meta.main) {
  await runApp(
    detectMode(process.argv),
    process.argv,
    buildRealDeps(createAppContext),
  )
}
