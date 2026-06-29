import type { GuiContext } from "./composition"
import { mountAppMenu } from "./gui/app-menu"
import { enrichGuiPathAsync } from "./gui/resolve-path"
import { mountTray } from "./gui/tray"
import { openWindow } from "./gui/window"

/** A handle to a running proxy this shell can later stop (mirrors proxy's RunningProxy.stop). */
export interface ProxyHandle {
  stop(): void
}

/**
 * The GUI effects the entry invokes, injected so the wiring is unit-testable without Electrobun.
 * `startProxy` returns a handle whose `stop` halts the persistent GUI proxy; `openWindow` mounts
 * the webview + tray. No CLI branch.
 */
export interface RunGuiDeps {
  readonly startProxy: () => ProxyHandle
  readonly openWindow: () => void
  /** Await the async GUI PATH enrichment (memoized; resolves immediately if already settled).
   * The harness-launch path MUST await this before resolving a harness command, so a launch
   * never races the still-pending login-shell PATH probe. */
  readonly ensureGuiPathResolved: () => Promise<void>
}

/**
 * Build the `RunGuiDeps` the GUI entry needs, wiring the real subsystems via `createGuiContext`.
 * Exported (and parameterized by the factory + optional overrides) so it is unit-testable without
 * constructing real adapters or importing Electrobun at top level.
 *
 * SECURITY: the GUI proxy is started bound to loopback from `config.settings.proxyHost` via
 * `ctx.proxy.start(...)`, with a freshly generated per-run key — never `0.0.0.0`.
 */
export const buildRealDeps = (
  makeContext: () => GuiContext,
  overrides: Partial<RunGuiDeps> = {},
): RunGuiDeps => {
  const ctx = makeContext()
  return {
    startProxy:
      overrides.startProxy ??
      ((): ProxyHandle => {
        // GUI startup path only. A Finder/Dock-launched app inherits a minimal PATH that omits
        // the user's CLI install dirs (~/.local/bin, /opt/homebrew/bin, nvm/asdf shims), so
        // `Bun.which("claude")` returns null and every launch fails with "failed to resolve
        // harness launch". Reconstruct the real PATH (login-shell probe + static fallback) BEFORE
        // anything resolves a harness command.
        //
        // The probe is kicked asynchronously so it NEVER blocks the Worker's JS thread during
        // the packaged-GUI startup / first-IPC window. The synchronous `Bun.spawnSync` here was
        // the single heavyweight native effect on the Worker's hot path right before the
        // nondeterministic `EXC_BREAKPOINT`/`brk 1` crash on the Worker thread (which survives
        // the #94/#98 dlopen-retention fixes and the #99 bundled-bun bump). The probe is
        // memoized and awaited on-demand via `RunGuiDeps.ensureGuiPathResolved` before any
        // harness is launched, so PATH is always ready by the time a command is resolved — but
        // never synchronously at startup.
        void enrichGuiPathAsync()
          .then((resolvedPath) =>
            ctx.log.child("startup").info("resolved gui PATH", {
              entries: resolvedPath.split(":").length,
            }),
          )
          .catch(() => {
            /* enrichment never rejects, but never let a log write reject the chain */
          })

        // Mark any sessions that were still "running" when the app was previously killed as ended.
        // The CLI must NOT call this: a live GUI proxy's sessions are genuinely running, and a CLI
        // invocation running alongside the GUI must not close them.
        const reconciled = ctx.sessions.reconcileOrphaned()
        if (!reconciled.ok) {
          // Non-fatal: log and continue rather than crashing GUI startup.
          // Redact to the SessionError discriminant (+ detail when present); never log secrets.
          ctx.log.child("startup").warn("reconcileOrphaned failed", {
            kind: reconciled.error.kind,
            ...("detail" in reconciled.error
              ? { detail: reconciled.error.detail }
              : {}),
          })
        }

        // Load the live config so the GUI proxy's router knows the real providers + models.
        // A fresh install loads defaults (empty providers/models) — still loopback + valid.
        let stop = (): void => {}
        void ctx.config.load().then((loaded) => {
          if (!loaded.ok) return
          // Capture the per-run key so we can both hand it to the proxy AND persist it for the
          // CLI to reuse (otherwise a CLI `launch` would mint a key this proxy rejects).
          const proxyKey = ctx.genProxyKey()
          const running = ctx.proxy.start({
            host: loaded.value.settings.proxyHost,
            port: ctx.proxyPort,
            proxyKey,
            config: loaded.value,
          })
          void ctx.runtime.writeProxyKey(proxyKey)
          stop = running.stop
        })
        return {
          stop: () => {
            ctx.log.child("startup").info("gui shutting down")
            stop()
            void ctx.runtime.clear()
          },
        }
      }),
    openWindow:
      overrides.openWindow ??
      ((): void => {
        // The native Edit menu (Copy/Paste/Cut/Select All) is REQUIRED for clipboard shortcuts to
        // reach the webview — without it Cmd+C/V do nothing in the conversation + composer.
        mountAppMenu()
        openWindow(ctx)
        ctx.log.child("startup").info("gui ready")
        void mountTray(ctx, {
          openWindow: () => openWindow(ctx),
          quit: () => process.exit(0),
        })
      }),
    ensureGuiPathResolved:
      overrides.ensureGuiPathResolved ??
      (async () => {
        await enrichGuiPathAsync()
      }),
  }
}

/**
 * Entry wiring (pure, exported for testing): start the proxy, then open the window. No CLI branch.
 *
 * argv is accepted for signature stability (the Electrobun Worker passes `process.argv`) but is
 * no longer routed on — the desktop binary is single-purpose GUI.
 */
export const main = (
  _argv: readonly string[],
  deps: RunGuiDeps,
): Promise<void> => {
  deps.startProxy()
  deps.openWindow()
  return Promise.resolve()
}
