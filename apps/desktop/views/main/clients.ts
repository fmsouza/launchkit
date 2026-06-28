import type { RunnerInbound, RunnerOutbound } from "@spectrum/agent-driver"
import { type IpcClient, createIpcClient } from "@spectrum/ipc"
import { type TerminalInbound, isTerminalOutbound } from "@spectrum/pty"
import { Electroview, type RPCSchema } from "electrobun/view"
import { type ElectrobunRpc, createElectrobunTransport } from "./ipc-client"
import { type RunnerClient, createRunnerClient } from "./runner/runnerClient"
import {
  type TerminalClient,
  createTerminalClient,
} from "./terminal/terminalClient"
import { type UpdateClient, createUpdateClient } from "./update/updateClient"

/** The Electroview only carries the IPC requests channel now (run events run over a WebSocket). */
type EmptySchema = {
  readonly bun: RPCSchema
  readonly webview: RPCSchema
}

/**
 * Build a `RunnerClient` over a dedicated loopback WebSocket (served by the bun
 * side — see apps/desktop/src/gui/runner-socket.ts): inbound `RunnerOutbound`
 * frames are dispatched; outbound `RunnerInbound` frames are JSON-sent (buffered
 * until open). Plain JSON — no base64.
 */
const createWsRunnerClient = (url: string): RunnerClient => {
  const ws = new WebSocket(url)
  const outbox: RunnerInbound[] = []
  const send = (message: RunnerInbound): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    else outbox.push(message)
  }
  const client = createRunnerClient(send)
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
    client.dispatch(parsed as RunnerOutbound)
  })
  return client
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
