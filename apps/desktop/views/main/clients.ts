import type { RunnerInbound, RunnerOutbound } from "@spectrum/agent-driver"
import { type IpcClient, createIpcClient } from "@spectrum/ipc"
import { type TerminalInbound, isTerminalOutbound } from "@spectrum/pty"
import { Electroview, type RPCSchema } from "electrobun/view"
import { type ElectrobunRpc, createElectrobunTransport } from "./ipc-client"
import { backoffDelay } from "./runner/reconnect"
import { type RunnerClient, createRunnerClient } from "./runner/runnerClient"
import {
  type TerminalClient,
  createTerminalClient,
} from "./terminal/terminalClient"
import { type UpdateClient, createUpdateClient } from "./update/updateClient"

/** The minimal WebSocket surface the runner transport uses (fake-able in tests). */
export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: "message", cb: (e: { data?: unknown }) => void): void
  addEventListener(type: "open" | "close" | "error", cb: () => void): void
}

export type WsRunnerDeps = {
  readonly createSocket?: (url: string) => WebSocketLike
  readonly setTimer?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  readonly now?: () => number
}

/** The Electroview only carries the IPC requests channel now (run events run over a WebSocket). */
type EmptySchema = {
  readonly bun: RPCSchema
  readonly webview: RPCSchema
}

/**
 * Build a self-reconnecting `RunnerClient` over the loopback runner WebSocket.
 * Auto-reconnects on close/error with capped backoff, tracks the time of the last
 * inbound frame (for liveness), and reports connection-state transitions so the UI
 * can show a discreet reconnecting indicator. Outbound frames buffer until open and
 * flush on every (re)connect.
 */
export const createWsRunnerClient = (
  url: string,
  deps: WsRunnerDeps = {},
): RunnerClient => {
  const createSocket =
    deps.createSocket ??
    ((u: string): WebSocketLike => new WebSocket(u) as unknown as WebSocketLike)
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  const now = deps.now ?? ((): number => Date.now())

  const outbox: RunnerInbound[] = []
  let ws: WebSocketLike | undefined
  let generation = 0
  let attempts = 0
  let everConnected = false
  let lastFrameAt = now()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const rawSend = (message: RunnerInbound): void => {
    if (ws !== undefined && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(message))
    else outbox.push(message)
  }
  const client = createRunnerClient(rawSend)

  const flush = (socket: WebSocketLike): void => {
    while (outbox.length > 0) {
      const next = outbox.shift()
      if (next !== undefined) socket.send(JSON.stringify(next))
    }
  }

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== undefined) return
    const delay = backoffDelay(attempts++)
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const connect = (): void => {
    const gen = ++generation
    const socket = createSocket(url)
    ws = socket
    client.reportConnectionState(everConnected ? "reconnecting" : "connecting")

    socket.addEventListener("open", () => {
      if (gen !== generation) return
      attempts = 0
      everConnected = true
      if (reconnectTimer !== undefined) {
        clearTimer(reconnectTimer)
        reconnectTimer = undefined
      }
      client.reportConnectionState("connected")
      flush(socket)
    })
    socket.addEventListener("message", (event: { data?: unknown }) => {
      if (gen !== generation) return
      if (typeof event.data !== "string") return
      lastFrameAt = now()
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      client.dispatch(parsed as RunnerOutbound)
    })
    const onDrop = (): void => {
      if (gen !== generation) return
      client.connectionLost()
      client.reportConnectionState("reconnecting")
      scheduleReconnect()
    }
    socket.addEventListener("close", onDrop)
    socket.addEventListener("error", onDrop)
  }

  // Transport-backed overrides of the pure client's defaults.
  const transportClient: RunnerClient = {
    ...client,
    getLastFrameMs: () => lastFrameAt,
    reconnect: () => {
      attempts = 0
      if (reconnectTimer !== undefined) {
        clearTimer(reconnectTimer)
        reconnectTimer = undefined
      }
      // Invalidate the current generation BEFORE closing so the synchronous
      // close event (e.g. FakeSocket) is already stale-guarded.
      generation++
      try {
        ws?.close()
      } catch {
        // closing an already-dead socket is fine; the gen guard ignores its events
      }
      connect()
    },
  }

  connect()
  return transportClient
}

/**
 * Build a `TerminalClient` over a dedicated loopback WebSocket (served by the bun
 * side — see apps/desktop/src/gui/terminal-socket.ts): inbound `TerminalOutbound`
 * frames are dispatched (zod-validated via `isTerminalOutbound`); outbound
 * `TerminalInbound` frames are JSON-sent (buffered until open). Plain JSON — no
 * base64 envelope here; PTY bytes are already base64 inside the wire schema.
 */
const createWsTerminalClient = (url: string): TerminalClient => {
  const ws = new WebSocket(url)
  const outbox: TerminalInbound[] = []
  const send = (message: TerminalInbound): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    else outbox.push(message)
  }
  const client = createTerminalClient(send)
  ws.addEventListener("open", () => {
    while (outbox.length > 0) {
      const next = outbox.shift()
      if (next !== undefined) ws.send(JSON.stringify(next))
    }
  })
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (!isTerminalOutbound(parsed)) return
    client.dispatch(parsed)
  })
  return client
}

/**
 * Build an `UpdateClient` over a dedicated loopback WebSocket (served by the bun
 * side — see apps/desktop/src/gui/update-socket.ts): inbound `UpdateState` frames
 * are JSON-parsed and dispatched (zod-validated inside `dispatch`). Push-only — the
 * webview sends nothing on this socket.
 */
const createWsUpdateClient = (url: string): UpdateClient => {
  const ws = new WebSocket(url)
  const client = createUpdateClient()
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    client.dispatch(parsed)
  })
  return client
}

/**
 * Construct the single Electroview (IPC requests only) and return all clients: the typed `IpcClient`
 * over Electrobun, a `RunnerClient` over the dedicated runner WebSocket, a `TerminalClient` over
 * the dedicated terminal WebSocket, and an `UpdateClient` over the dedicated update WebSocket —
 * all URLs fetched from the bun side via IPC. Called once by `app.tsx`.
 */
export const createRealClients = async (): Promise<{
  ipcClient: IpcClient
  runnerClient: RunnerClient
  terminalClient: TerminalClient
  updateClient: UpdateClient
}> => {
  const rpc = Electroview.defineRPC<EmptySchema>({
    maxRequestTime: Number.POSITIVE_INFINITY, // transport owns per-method timeouts
    handlers: { requests: {}, messages: {} },
  })
  const view = new Electroview({ rpc })
  const ipcClient = createIpcClient(
    createElectrobunTransport(view.rpc as unknown as ElectrobunRpc),
  )
  const [runnerRes, termRes, updateRes] = await Promise.all([
    ipcClient.getRunnerSocketUrl(undefined),
    ipcClient.getTerminalSocketUrl(undefined),
    ipcClient.getUpdateSocketUrl(undefined),
  ])
  const runnerClient = runnerRes.ok
    ? createWsRunnerClient(runnerRes.value.url)
    : createRunnerClient(() => {})
  const terminalClient = termRes.ok
    ? createWsTerminalClient(termRes.value.url)
    : createTerminalClient(() => {})
  const updateClient = updateRes.ok
    ? createWsUpdateClient(updateRes.value.url)
    : createUpdateClient()
  return { ipcClient, runnerClient, terminalClient, updateClient }
}
