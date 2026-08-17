import type { AppContext } from "../composition"

/**
 * The app-exit gate: stop everything Spectrum supervises before the process actually goes away.
 *
 * Electrobun funnels EVERY quit — Cmd+Q, the app menu, the tray's `process.exit(0)` (which
 * Electrobun patches onto `quit()`), the last window closing, and its own SIGINT/SIGTERM handlers
 * — through `Utils.quit()`, which emits `before-quit` SYNCHRONOUSLY and then force-exits. There is
 * no async window in that sequence, so an `await` inside a plain listener would never finish.
 *
 * The gate therefore uses the one asynchronous affordance the event has: it VETOES the first quit
 * (`response = { allow: false }`, which Electrobun honours by aborting the sequence), runs the
 * shutdown, and then re-issues the quit. The second pass sets no veto and the app exits.
 *
 * WHAT THIS DOES NOT COVER (accepted, not overlooked):
 * - `stop` signals a supervised child and does not await its exit, and there is no
 *   SIGTERM→SIGKILL escalation: a child that ignores the signal is not force-killed.
 * - The kill targets the child only, not its process group, so a plugin that forks its own
 *   children may still leak them.
 * - SIGKILL of Spectrum itself, or a hard crash, runs no handler at all.
 */

/** The subset of Electrobun's `before-quit` event this gate touches: the veto response. */
export type QuitEvent = {
  response: { allow: boolean }
}

export type QuitGateDeps = {
  /** Stop supervised state (the plugin provider child processes). */
  readonly shutdown: () => Promise<void>
  /** Re-issue the quit once shutdown has settled (Electrobun's `Utils.quit`). */
  readonly quit: () => void
  /** Report a failed shutdown. Never receives a secret — only the error's message. */
  readonly onShutdownFailed: (detail: string) => void
}

/**
 * Clock seam bounding the drain, injected so the never-settling case is testable without
 * wall-clock. Mirrors `StartupWait` in `main.ts`.
 */
export interface DrainWait {
  readonly capMs: number
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export const defaultDrainWait: DrainWait = {
  capMs: 2000,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Build the `before-quit` listener. Returns a plain synchronous handler, because that is what the
 * emitter calls; the async work is deliberately started and not awaited.
 *
 * The drain is CAPPED. `.catch`/`.finally` cover a rejected shutdown, not a pending one, and a
 * shutdown that never settles would mean the re-quit never issues — Cmd+Q silently doing nothing
 * is a worse outcome than a leaked child. `stopAll` cannot hang today (its `stop` fires `kill()`
 * and awaits nothing), but awaiting `exited` or adding SIGTERM→SIGKILL escalation — the very
 * limitations documented above — is exactly what would make it hang.
 */
export const createQuitGate = (
  deps: QuitGateDeps,
  wait: DrainWait = defaultDrainWait,
): ((event: QuitEvent) => void) => {
  let draining = false

  return (event: QuitEvent): void => {
    // Set BEFORE any await, so the re-issued quit below can never recurse into a second drain.
    //
    // This also means a user's SECOND Cmd+Q during the drain is passed straight through and
    // reaches `forceExit(0)` mid-shutdown, leaking whatever had not been killed yet. That is
    // deliberate — an app that refuses to close is worse — and the cap below bounds how long the
    // window stays open. Distinguishing our own re-quit from a user's would need an identity the
    // event does not carry.
    if (draining) return
    draining = true

    event.response = { allow: false }

    let settled = false
    // Initialized (not a bare `let cap`) so a synchronously-firing fake seam reads a defined value
    // instead of hitting the temporal dead zone — same reason as `awaitReadyWithCap` in main.ts.
    let cap: unknown = undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      wait.clearTimeout(cap)
      deps.quit()
    }
    cap = wait.setTimeout(() => {
      deps.onShutdownFailed(`shutdown did not settle within ${wait.capMs}ms`)
      finish()
    }, wait.capMs)

    void deps
      .shutdown()
      .catch((cause: unknown) => {
        deps.onShutdownFailed(
          cause instanceof Error ? cause.message : String(cause),
        )
      })
      // A failed teardown must not strand the user in an app that refuses to close.
      .finally(finish)
  }
}

/**
 * Everything the mount needs from the app context. Narrowed to two members (rather than taking a
 * whole `GuiContext`) so the scripted quit check in `scripts/quit-check.ts` can drive the REAL
 * mount against a bare `AppContext`, with no window, tray or run manager.
 */
export type QuitGateContext = Pick<AppContext, "shutdown" | "log">

/**
 * The native seam: register the gate on Electrobun's `before-quit`. Thin by design — all the
 * decision logic is in `createQuitGate` above.
 *
 * The import is LAZY like every other native touchpoint here, so `bun test` never loads
 * Electrobun's FFI. `events` is reachable only through the default export (see
 * `../types/electrobun-bun.d.ts`).
 *
 * Returns a promise that settles once the listener is registered (it never rejects — a failed
 * registration is logged). The GUI entry ignores it; `scripts/quit-check.ts` awaits it, because a
 * signal arriving before registration would test nothing.
 */
export const mountQuitGate = (ctx: QuitGateContext): Promise<void> =>
  import("electrobun/bun")
    .then(({ default: Electrobun, Utils }) => {
      Electrobun.events.on(
        "before-quit",
        createQuitGate({
          shutdown: () => ctx.shutdown(),
          quit: () => Utils.quit(),
          onShutdownFailed: (detail) =>
            ctx.log
              .child("shutdown")
              .error("plugin shutdown failed", { detail }),
        }),
      )
    })
    .catch((cause: unknown) => {
      // A gate that never registered means supervised plugin processes are orphaned on quit.
      // Never silent.
      ctx.log.child("shutdown").error("quit gate not installed", {
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    })
