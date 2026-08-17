import type { PluginError } from "@spectrum/extensions"
import { type Result, err, ok } from "@spectrum/utils"

export type PortAllocator = {
  allocate(): Promise<Result<number, PluginError>>
}

/**
 * Binds 127.0.0.1:0 to let the OS pick a free port, reads it back, then stops the
 * server and hands the bare number to the caller. There is a deliberate TOCTOU window
 * between the server stopping and the child process binding that same port: any other
 * local process could grab it first. This is accepted, not overlooked — the host-token
 * check in readiness.ts is the mitigation, so a squatter that wins the race is never
 * treated as the real plugin.
 */
export const createLoopbackPortAllocator = (): PortAllocator => ({
  allocate: async (): Promise<Result<number, PluginError>> => {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (): Response => new Response(null, { status: 404 }),
      })
      const { port } = server
      server.stop(true)
      if (port === undefined) {
        return err({
          kind: "write-failed",
          detail: "loopback server bound with no port",
        })
      }
      return ok(port)
    } catch (error) {
      return err({
        kind: "write-failed",
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  },
})
