import type { Logger } from "@spectrum/logger"
import type { UpdatePhase } from "./updater-adapter"

/** Re-check the release feed while the app is open. Tunable. */
export const UPDATE_POLL_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

/** Timer seam — injected so tests don't start a real 3-min interval. */
export interface PollerTimers {
  readonly setInterval: (f: () => void, ms: number) => number
  readonly clearInterval: (id: number) => void
}

/** Production timers — injected in tests so the scheduling logic runs without real time. */
export const realPollerTimers: PollerTimers = {
  setInterval: (f: () => void, ms: number): number =>
    setInterval(f, ms) as unknown as number,
  clearInterval: (id: number): void => clearInterval(id),
}

export interface UpdatePoller {
  start(): void
  stop(): void
}

/**
 * Periodically re-checks for updates by calling the injected `check` thunk (which performs the
 * network check and pushes the fresh state to the webview). Skips a cycle when the adapter is
 * mid-download/apply (the in-flight op owns phase/progress). A failed or throwing `check` is
 * logged at the boundary and the interval keeps ticking — one bad cycle never kills the poller.
 */
export const createUpdatePoller = (deps: {
  readonly check: () => Promise<void>
  readonly getPhase: () => UpdatePhase
  readonly intervalMs: number
  readonly timers: PollerTimers
  readonly logger: Logger
}): UpdatePoller => {
  let id: number | null = null
  const tick = async (): Promise<void> => {
    const phase = deps.getPhase()
    if (phase === "downloading" || phase === "applying") return
    try {
      await deps.check()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      deps.logger.error(`update.poll.error: ${detail}`)
    }
  }
  return {
    start() {
      if (id !== null) return
      id = deps.timers.setInterval(() => {
        void tick()
      }, deps.intervalMs)
    },
    stop() {
      if (id === null) return
      deps.timers.clearInterval(id)
      id = null
    },
  }
}
