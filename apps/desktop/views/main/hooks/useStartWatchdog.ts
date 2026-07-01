import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Guards the "Starting…" pane against a permanent silent hang. While `active`
 * (a started session whose root runner has not appeared): re-attach once after
 * `reattachDelayMs` (self-heals a lost attach/replay); if still active at
 * `failDelayMs`, surface `failed` so the caller can show an error + Retry.
 * `retry()` re-attaches immediately and restarts the clock.
 */
export const useStartWatchdog = (deps: {
  readonly active: boolean
  readonly reattach: () => void
  readonly reattachDelayMs?: number
  readonly failDelayMs?: number
}): { readonly failed: boolean; retry: () => void } => {
  const { active, reattach } = deps
  const reattachDelayMs = deps.reattachDelayMs ?? 3000
  const failDelayMs = deps.failDelayMs ?? 15000
  const [failed, setFailed] = useState(false)
  const reattachRef = useRef(reattach)
  reattachRef.current = reattach

  useEffect(() => {
    if (!active) {
      setFailed(false)
      return
    }
    const t1 = setTimeout(() => reattachRef.current(), reattachDelayMs)
    const t2 = setTimeout(() => setFailed(true), failDelayMs)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [active, reattachDelayMs, failDelayMs])

  const retry = useCallback(() => {
    setFailed(false)
    reattachRef.current()
  }, [])

  return { failed, retry }
}
