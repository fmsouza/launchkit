import { type ClientTransport, createIpcClient } from "@spectrum/ipc"

/** Re-export the webview's client type so pages/hooks import it from one place. */
export type { IpcClient } from "@spectrum/ipc"
export { createIpcClient }

/**
 * The Electrobun RPC surface this adapter calls. We only ever invoke `request`
 * (main->webview handlers return values); `send` (fire-and-forget) is unused here.
 * Exported so `clients.ts` can build the transport over the shared Electroview.
 */
export type ElectrobunRpc = {
  readonly request: Readonly<
    Record<string, (payload: unknown) => Promise<unknown>>
  >
}

/** Default per-method timeout overrides. `Infinity` disables the timeout entirely. */
const DEFAULT_METHOD_TIMEOUT_MS: Readonly<Record<string, number>> = {
  pickFolder: Number.POSITIVE_INFINITY, // interactive native dialog — never time out
  pickUploads: Number.POSITIVE_INFINITY, // interactive native multi-file dialog — never time out
  listProviderModels: 30_000, // network to the provider
  testProvider: 30_000, // network to the provider
  listProviderModelsDraft: 30_000, // network to the provider (draft)
  testProviderDraft: 30_000, // network to the provider (draft)
  // The on-open update check lazily imports Electrobun's native updater engine AND
  // performs a network fetch in a single call. On a cold first launch that easily
  // exceeds the 5s default, which would surface as a transport timeout — the store
  // then leaves its state `undefined` and the Updates box shows "…" until a warm
  // re-check succeeds. Give it the same network-grade budget as the provider calls.
  checkForUpdate: 30_000, // cold native engine import + network update.json fetch
}

const DEFAULT_TIMEOUT_MS = 5_000

/** Optional configuration for `createElectrobunTransport`. */
export type ElectrobunTransportOpts = {
  /**
   * Per-method timeout overrides (ms). `Infinity` disables timeout for that
   * method. Methods not listed fall back to `defaultTimeoutMs`.
   */
  readonly timeouts?: Readonly<Record<string, number>>
  /** Default timeout for methods not listed in `timeouts` (ms). Default 5000. */
  readonly defaultTimeoutMs?: number
}

/**
 * The single Electrobun-coupled file. Wraps `Electroview.rpc.request.<method>`
 * in the transport-agnostic `ClientTransport` interface so everything above it
 * (hooks, pages) is tested with a fake client and no Electrobun runtime.
 *
 * Each call is raced against a configurable per-method timeout. Interactive
 * methods (e.g. `pickFolder`) are configured with `Infinity` to skip the race.
 * Callers can inject custom timeouts via `opts` for testing.
 */
export const createElectrobunTransport = (
  rpc: ElectrobunRpc,
  opts?: ElectrobunTransportOpts,
): ClientTransport => {
  const methodTimeouts = opts?.timeouts ?? DEFAULT_METHOD_TIMEOUT_MS
  const defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    send: (method, payload) => {
      const call = rpc.request[method]
      if (call === undefined) {
        return Promise.reject(new Error(`unknown ipc method: ${method}`))
      }

      const timeoutMs = methodTimeouts[method] ?? defaultTimeoutMs

      if (!Number.isFinite(timeoutMs)) {
        // No timeout — return the call directly (interactive or explicitly exempt).
        return call(payload)
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("RPC request timed out"))
        }, timeoutMs)

        call(payload).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (err: unknown) => {
            clearTimeout(timer)
            reject(err)
          },
        )
      })
    },
  }
}
