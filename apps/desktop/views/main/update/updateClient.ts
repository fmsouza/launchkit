import { type UpdateState, UpdateStateSchema } from "@spectrum/ipc"

export interface UpdateClient {
  /** Register a listener for server-pushed UpdateState frames. Returns an unsubscribe. */
  onUpdateState(cb: (state: UpdateState) => void): () => void
  /** Validate and route an inbound (parsed) frame. Drops malformed frames. */
  dispatch(parsed: unknown): void
}

/**
 * Transport-agnostic update client. The bun side pushes `UpdateState` frames over a dedicated
 * loopback WebSocket; the WS wrapper JSON-parses each message and calls `dispatch`. Frames are
 * zod-validated here (untrusted-transport boundary) before reaching the store — mirrors
 * `isTerminalOutbound` in the terminal client.
 */
export const createUpdateClient = (): UpdateClient => {
  const listeners = new Set<(state: UpdateState) => void>()
  return {
    onUpdateState(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    dispatch(parsed) {
      const result = UpdateStateSchema.safeParse(parsed)
      if (!result.success) return
      for (const cb of listeners) cb(result.data)
    },
  }
}
