import type { GuiContext } from "./composition"
import { mountAppMenu } from "./gui/app-menu"
import { mountQuitGate } from "./gui/quit-gate"
import { enrichGuiPathAsync } from "./gui/resolve-path"
import { mountTray } from "./gui/tray"
import { openWindow } from "./gui/window"

/** A handle to a running proxy this shell can later stop (mirrors proxy's RunningProxy.stop). */
export interface ProxyHandle {
  stop(): void
  /**
   * Settles once the startup burst is done: config loaded and the proxy started (or the load
   * failed — settled either way, never rejects). The window MUST NOT open before this settles:
   * the webview's first load drives Electrobun native->Worker JSCallback traffic (navigation
   * events, views:// mime lookups), and bun's cross-thread JSCallback support corrupts the
   * Worker's JS VM when that traffic lands while the Worker is mid-burst (EXC_BREAKPOINT /
   * PAC-IB trap — the post-update startup crash; same class as the #94/#98/#99/#100 incidents).
   */
  readonly ready: Promise<void>
}

/**
 * Clock seam for the pre-window readiness wait, injected so tests drive the cap manually.
 * `capMs` bounds how long `main` waits on `ProxyHandle.ready` before opening the window
 * anyway — a hung config load must degrade to today's behavior, never a windowless app.
 */
export interface StartupWait {
  readonly capMs: number
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export const defaultStartupWait: StartupWait = {
  capMs: 3000,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Which signal ended the pre-window wait — surfaced so the entry can log a cap expiry. */
export type StartupOutcome = "ready" | "cap-expired"

/**
 * Await `ready` but never longer than the cap; settles (never rejects) on either outcome,
 * reporting which signal won. `cap` is declared before `finish` (not `const cap = setTimeout`)
 * so a fake seam that fires its callback synchronously can't hit the temporal-dead-zone
 * ReferenceError that would reject this promise — the never-reject contract must hold for any
 * injected `StartupWait`, not just real timers.
 */
const awaitReadyWithCap = (
  ready: Promise<void>,
  wait: StartupWait,
): Promise<StartupOutcome> =>
  new Promise((resolve) => {
    let settled = false
    // Initialized (not a bare `let cap`) so a synchronously-firing fake seam reads a defined
    // value instead of hitting the temporal dead zone — see the doc comment above.
    let cap: unknown = undefined
    const finish = (outcome: StartupOutcome): void => {
      if (settled) return
      settled = true
      wait.clearTimeout(cap)
      resolve(outcome)
    }
    cap = wait.setTimeout(() => finish("cap-expired"), wait.capMs)
    ready.then(
      () => finish("ready"),
      () => finish("ready"),
    )
  })

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
  /** Called when the pre-window wait hit its cap instead of `startProxy().ready` settling — the
   * window is opening into a possibly-still-running startup burst, the exact condition this gate
   * exists to avoid. Wired to a boundary warn so the next triage of this crash class can tell a
   * capped-open from a clean one. Optional so lightweight test deps can omit it. */
  readonly onStartupCapExpired?: () => void
  /**
   * Register the `before-quit` gate that stops supervised plugin processes before the app exits
   * (see `gui/quit-gate.ts`). Optional so lightweight test deps can omit it — but the real entry MUST
   * supply it: nothing else calls `AppContext.shutdown()`, so without it every plugin child
   * survives the quit as an orphan.
   */
  readonly installQuitGate?: () => void
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
        // The chain is exposed as `ready` so `main` can hold the window (and the webview's
        // native->Worker callback traffic) until the startup burst has settled.
        let stop = (): void => {}
        const ready = ctx.config
          .load()
          .then(async (loaded) => {
            if (!loaded.ok) {
              // Boundary log: without it a failed load silently leaves the proxy down and
              // this exact stall is invisible in the startup log (as in the crash triage).
              ctx.log
                .child("startup")
                .error("config load failed; proxy not started", {
                  kind: loaded.error.kind,
                })
              return
            }
            // Capture the per-run key so we can both hand it to the proxy AND persist it for the
            // CLI to reuse (otherwise a CLI `launch` would mint a key this proxy rejects).
            const proxyKey = ctx.genProxyKey()
            const running = ctx.proxy.start({
              host: loaded.value.settings.proxyHost,
              port: ctx.proxyPort,
              proxyKey,
              config: loaded.value,
            })
            stop = running.stop
            // Await the key persist INSIDE `ready` so the window never opens with startup IO
            // still in flight (the whole point of the gate); surface a failed write instead of
            // dropping the Result — a CLI `launch` reads this key and would otherwise mint one
            // the proxy rejects, with no clue why.
            const wrote = await ctx.runtime.writeProxyKey(proxyKey)
            if (!wrote.ok) {
              ctx.log
                .child("startup")
                .error("proxy key persist failed", { kind: wrote.error.kind })
            }
          })
          .catch((e: unknown) => {
            // `ready` gates the window; it must settle even if the load/start chain THROWS
            // (e.g. proxy.start -> Bun.serve EADDRINUSE on a stale instance). Swallowing this
            // silently — as the first cut did — recreates the invisible-proxy-down blind spot
            // the !loaded.ok log above exists to close, so log the message (not the raw error:
            // avoid leaking a stack/paths) at the boundary while still resolving.
            ctx.log
              .child("startup")
              .error("startup burst threw; proxy not started", {
                detail: e instanceof Error ? e.message : String(e),
              })
          })
        return {
          ready,
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
    installQuitGate:
      overrides.installQuitGate ??
      ((): void => {
        mountQuitGate(ctx)
      }),
    onStartupCapExpired:
      overrides.onStartupCapExpired ??
      ((): void => {
        ctx.log
          .child("startup")
          .warn("startup did not settle before cap; opening window anyway")
      }),
  }
}

/**
 * Entry wiring (pure, exported for testing): start the proxy, wait for the startup burst to
 * settle (bounded by `wait.capMs`), then open the window. No CLI branch.
 *
 * SEQUENCING INVARIANT: `openWindow` runs only after `startProxy().ready` settles (or the cap
 * fires). Opening the webview mid-burst lets Electrobun's native threads call into the busy
 * Worker VM via bun:ffi JSCallbacks and corrupts it — the post-update EXC_BREAKPOINT startup
 * crash (regression guard in main.test.ts, "main startup sequencing").
 *
 * argv is accepted for signature stability (the Electrobun Worker passes `process.argv`) but is
 * no longer routed on — the desktop binary is single-purpose GUI.
 */
export const main = async (
  _argv: readonly string[],
  deps: RunGuiDeps,
  wait: StartupWait = defaultStartupWait,
): Promise<void> => {
  // Registered FIRST: a quit arriving during the startup burst must still drain supervised
  // children, and the gate needs no proxy or window to do its job.
  deps.installQuitGate?.()
  const proxy = deps.startProxy()
  const outcome = await awaitReadyWithCap(proxy.ready, wait)
  if (outcome === "cap-expired") deps.onStartupCapExpired?.()
  deps.openWindow()
}
