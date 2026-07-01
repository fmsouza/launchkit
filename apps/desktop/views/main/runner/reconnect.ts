/** Connection-state string union (re-exported from runnerClient in Task 2; kept local-compatible here). */
export type ConnectionState = "connecting" | "connected" | "reconnecting"

/**
 * Capped exponential backoff with a floor. Deterministic (no jitter — runner-socket
 * reconnects are rare and single-client, so thundering-herd is not a concern).
 */
export const backoffDelay = (
  attempt: number,
  opts?: { baseMs?: number; maxMs?: number },
): number => {
  const baseMs = opts?.baseMs ?? 500
  const maxMs = opts?.maxMs ?? 10_000
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
}

/**
 * True only when the machine almost certainly slept (a tick gap larger than `gapMs`)
 * AND the runner socket has delivered nothing recently (`nowMs - lastFrameMs > staleMs`).
 * The staleness gate is what stops a heavy-streaming main-thread block from forcing a
 * needless reconnect: during streaming, frames are recent, so this returns false.
 */
export const shouldForceReconnect = (i: {
  prevTickMs: number
  nowMs: number
  lastFrameMs: number
  gapMs: number
  staleMs: number
}): boolean => {
  const wokeUp = i.nowMs - i.prevTickMs > i.gapMs
  const stale = i.nowMs - i.lastFrameMs > i.staleMs
  return wokeUp && stale
}

/**
 * Re-attach (reset + replay) is warranted only when the socket has RE-established after a
 * drop — not on the very first connect (the mount-time attach already covers that).
 */
export const shouldReattach = (
  prev: ConnectionState,
  next: ConnectionState,
): boolean => prev === "reconnecting" && next === "connected"
