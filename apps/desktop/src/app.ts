import type { AppMode } from "./detect-mode"

/** A handle to a running proxy this shell can later stop (mirrors proxy's RunningProxy.stop). */
export interface ProxyHandle {
  stop(): void
}

/**
 * The two effects `runApp` chooses between, injected so the router is pure logic.
 * `startProxy` receives the wired AppContext (typed `unknown` here to keep this module free of
 * a `composition.ts` import cycle — `main.ts` supplies a correctly-typed function); `openWindow`
 * mounts the Electrobun webview.
 */
export interface RunAppDeps {
  readonly runCli: (argv: readonly string[]) => Promise<unknown>
  readonly startProxy: (ctx: unknown) => ProxyHandle
  readonly openWindow: () => void
}

/**
 * Run exactly one mode. `"cli"` parses argv + runs a command (the proxy starts ephemerally inside
 * the CLI's own launch path, not here). `"gui"` starts the persistent background proxy, then opens
 * the window. The other path's effects are never invoked — asserted in the tests with fakes.
 */
export const runApp = async (
  mode: AppMode,
  argv: readonly string[],
  deps: RunAppDeps,
): Promise<void> => {
  if (mode === "cli") {
    await deps.runCli(argv)
    return
  }
  deps.startProxy(undefined)
  deps.openWindow()
}
