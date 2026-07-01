import { useEffect, useRef, useState } from "react"
import { shouldForceReconnect } from "../runner/reconnect"
import type { ConnectionState, RunnerClient } from "../runner/runnerClient"

/**
 * Subscribes to the runner socket's connection state (drives the rail indicator) and
 * runs a lightweight wake/staleness watchdog: on a detected sleep gap with no recent
 * inbound frames, it forces the transport to reconnect. No IPC ping, no page reload.
 */
export const useRunnerConnection = (deps: {
  readonly runnerClient: RunnerClient
  readonly now: () => number
  readonly tickMs?: number
  readonly gapMs?: number
  readonly staleMs?: number
}): { readonly state: ConnectionState } => {
  const { runnerClient, now } = deps
  const tickMs = deps.tickMs ?? 2000
  const gapMs = deps.gapMs ?? 10000
  const staleMs = deps.staleMs ?? 15000
  const [state, setState] = useState<ConnectionState>(
    runnerClient.connectionState(),
  )
  const lastTick = useRef(now())

  useEffect(() => {
    setState(runnerClient.connectionState())
    const off = runnerClient.onConnectionState(setState)
    return off
  }, [runnerClient])

  useEffect(() => {
    const handle = setInterval(() => {
      const current = now()
      const prev = lastTick.current
      lastTick.current = current
      if (
        shouldForceReconnect({
          prevTickMs: prev,
          nowMs: current,
          lastFrameMs: runnerClient.getLastFrameMs(),
          gapMs,
          staleMs,
        })
      )
        runnerClient.reconnect()
    }, tickMs)
    return () => clearInterval(handle)
  }, [runnerClient, now, tickMs, gapMs, staleMs])

  return { state }
}
