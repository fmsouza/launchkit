import type { GuiContext } from "../composition"

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
 * Build the `before-quit` listener. Returns a plain synchronous handler, because that is what the
 * emitter calls; the async work is deliberately started and not awaited.
 */
export const createQuitGate = (
  deps: QuitGateDeps,
): ((event: QuitEvent) => void) => {
  let draining = false

  return (event: QuitEvent): void => {
    // Second pass (our own re-issued quit) — or a quit that raced the drain: set no veto and let
    // the sequence run. Re-vetoing here would make the app unquittable.
    if (draining) return
    draining = true

    event.response = { allow: false }

    void deps
      .shutdown()
      .catch((cause: unknown) => {
        deps.onShutdownFailed(
          cause instanceof Error ? cause.message : String(cause),
        )
      })
      // A failed teardown must not strand the user in an app that refuses to close.
      .finally(() => {
        deps.quit()
      })
  }
}

/**
 * The native seam: register the gate on Electrobun's `before-quit`. Thin by design — all the
 * decision logic is in `createQuitGate` above.
 *
 * The import is LAZY like every other native touchpoint here, so `bun test` never loads
 * Electrobun's FFI. `events` is reachable only through the default export (see
 * `../types/electrobun-bun.d.ts`).
 */
export const mountQuitGate = (ctx: GuiContext): void => {
  void import("electrobun/bun")
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
}
