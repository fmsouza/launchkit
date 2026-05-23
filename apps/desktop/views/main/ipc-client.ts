import { Electroview } from "electrobun/view"
import { type ClientTransport, createIpcClient, type IpcClient } from "@launchkit/ipc"

/** Re-export the webview's client type so pages/hooks import it from one place. */
export type { IpcClient } from "@launchkit/ipc"

/**
 * The Electrobun RPC surface this adapter calls. We only ever invoke `request`
 * (main->webview handlers return values); `send` (fire-and-forget) is unused here.
 */
type ElectrobunRpc = {
  readonly request: Readonly<Record<string, (payload: unknown) => Promise<unknown>>>
}

/**
 * The single Electrobun-coupled file. Wraps `Electroview.rpc.request.<method>`
 * in the transport-agnostic `ClientTransport` interface so everything above it
 * (hooks, pages) is tested with a fake client and no Electrobun runtime.
 */
export const createElectrobunTransport = (rpc: ElectrobunRpc): ClientTransport => ({
  send: (method, payload) => {
    const call = rpc.request[method]
    if (call === undefined) {
      return Promise.reject(new Error(`unknown ipc method: ${method}`))
    }
    return call(payload)
  },
})

/**
 * Construct the Electroview, expose its RPC as a `ClientTransport`, and build
 * the typed `IpcClient` over it. Called once by `app.tsx` for the real client.
 * The empty handler set is intentional -- the webview answers no requests from
 * the main process; it only initiates them.
 */
export const createRealIpcClient = (): IpcClient => {
  const rpc = Electroview.defineRPC<Record<string, never>>({
    maxRequestTime: 5000,
    handlers: { requests: {}, messages: {} },
  })
  const view = new Electroview({ rpc })
  const transport = createElectrobunTransport(view.rpc as ElectrobunRpc)
  return createIpcClient(transport)
}
