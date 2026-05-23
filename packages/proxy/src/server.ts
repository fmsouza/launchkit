import { createHandler, type HandlerDeps } from "./handler"

export interface StartProxyOptions extends HandlerDeps { host: string; port: number }
export interface RunningProxy { hostname: string; port: number; stop(): void }

export const startProxy = (opts: StartProxyOptions): RunningProxy => {
  const handler = createHandler(opts)
  const server = Bun.serve({ hostname: opts.host, port: opts.port, fetch: handler.fetch })
  return { hostname: server.hostname, port: server.port, stop: () => server.stop(true) }
}

export const isProxyRunning = async (baseUrl: string, timeoutMs = 300): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch { return false }
}
