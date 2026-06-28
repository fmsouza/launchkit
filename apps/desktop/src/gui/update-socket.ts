import type { UpdateState } from "@spectrum/ipc"

export interface UpdateSocket {
  /** `ws://localhost:<port>/` — handed to the webview via the `getUpdateSocketUrl` IPC method. */
  readonly url: string
  /** Push a fresh `UpdateState` snapshot to the connected webview client (no-op when disconnected). */
  push(state: UpdateState): void
  stop(): void
}

/** Minimal seam matching Bun's websocket `send`, so the handlers are unit-testable without a server. */
interface SocketLike {
  send(data: string): void
}

/**
 * The pure message-handling core of the update socket, extracted so it is unit-tested without a
 * live `Bun.serve`. Push-only: the bun side re-checks the release feed on a timer and calls
 * `push(state)` to stream the fresh `UpdateState` to the webview. No inbound messages.
 */
export const makeUpdateSocketHandlers = (): {
  open(ws: SocketLike): void
  close(): void
  push(state: UpdateState): void
} => {
  let socket: SocketLike | null = null
  return {
    open(ws) {
      socket = ws
    },
    close() {
      socket = null
    },
    push(state) {
      if (socket === null) return
      try {
        socket.send(JSON.stringify(state))
      } catch {
        /* socket closing — drop; the next poll retries with a full snapshot */
      }
    },
  }
}

/**
 * A dedicated loopback WebSocket carrying pushed `UpdateState` frames, separate from Electrobun's
 * RPC and from the runner/terminal sockets. One webview ⇒ one connection. Push-only.
 */
export const startUpdateSocket = (): UpdateSocket => {
  const handlers = makeUpdateSocketHandlers()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response("spectrum update socket", { status: 426 })
    },
    websocket: {
      open(ws) {
        handlers.open(ws)
      },
      close() {
        handlers.close()
      },
      // No inbound messages — push-only.
      message() {},
    },
  })
  // Connect via `localhost` (not 127.0.0.1) so the webview CSP `connect-src ws://localhost:*` allows it.
  return {
    url: `ws://localhost:${server.port}/`,
    push: (state) => handlers.push(state),
    stop: () => server.stop(true),
  }
}
