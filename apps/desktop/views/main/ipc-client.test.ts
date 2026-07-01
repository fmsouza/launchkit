import { describe, expect, it } from "bun:test"
import { createElectrobunTransport } from "./ipc-client"

/**
 * Creates a deferred promise — resolves/rejects externally so tests can
 * control exactly when an IPC call settles without timing races.
 */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (v: T) => void
  readonly reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Race a promise against a wall-clock timeout; throws on timeout. */
const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  msg = "test timed out",
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ])

describe("createElectrobunTransport", () => {
  it("resolves with the value when the rpc call settles quickly", async () => {
    const rpc = {
      request: {
        listSessions: async (_: unknown) =>
          ({ ok: true, value: [] }) as unknown,
      },
    }
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 5_000,
    })
    const result = await transport.send("listSessions", undefined)
    expect(result).toEqual({ ok: true, value: [] })
  })

  it("rejects with 'RPC request timed out' when a call does not settle within the default timeout", async () => {
    const { promise } = deferred<unknown>()
    const rpc = {
      request: {
        someMethod: (_: unknown) => promise,
      },
    }
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 30, // tiny injected timeout
    })
    // The transport itself should reject; wrap in an outer guard so a
    // missing implementation causes a clear test-timeout failure, not a hang.
    await expect(
      withTimeout(transport.send("someMethod", undefined), 500, "test guard"),
    ).rejects.toThrow("RPC request timed out")
  }, 1000)

  it("does NOT time out a method configured with Infinity (pickFolder stays open until the user acts)", async () => {
    const { promise, resolve } = deferred<unknown>()
    const rpc = {
      request: {
        pickFolder: (_: unknown) => promise,
      },
    }
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 10, // would expire quickly if pickFolder weren't exempt
      timeouts: { pickFolder: Number.POSITIVE_INFINITY },
    })
    // Settle the deferred after a short delay — the transport must not have
    // already rejected it via timeout.
    const settled = { ok: true, value: { path: "/Users/me/work" } }
    setTimeout(() => resolve(settled), 50)
    const result = await withTimeout(
      transport.send("pickFolder", {}),
      200,
      "test guard",
    )
    expect(result).toEqual(settled)
  }, 1000)

  it("does NOT time out pickUploads under the 5s default (interactive native multi-file dialog)", async () => {
    const { promise, resolve } = deferred<unknown>()
    const rpc = {
      request: {
        pickUploads: (_: unknown) => promise,
      },
    }
    // No `timeouts` override → the transport falls back to its built-in
    // DEFAULT_METHOD_TIMEOUT_MS table. pickUploads must be Infinity there.
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 20,
    })
    const settled = { ok: true, value: { uploads: [], rejected: [] } }
    setTimeout(() => resolve(settled), 60)
    const result = await withTimeout(
      transport.send("pickUploads", {
        acceptedMimes: [],
        acceptedKinds: [],
      }),
      400,
      "test guard",
    )
    expect(result).toEqual(settled)
  }, 1000)

  it("does NOT time out checkForUpdate under the 5s default (cold native engine import + network check needs longer)", async () => {
    const { promise, resolve } = deferred<unknown>()
    const rpc = {
      request: {
        checkForUpdate: (_: unknown) => promise,
      },
    }
    // No `timeouts` override → the transport falls back to its built-in
    // DEFAULT_METHOD_TIMEOUT_MS table. A tiny default would expire a method
    // NOT in that table; checkForUpdate must be exempted with a generous budget.
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 20,
    })
    const settled = { ok: true, value: { phase: "up-to-date" } }
    setTimeout(() => resolve(settled), 60)
    const result = await withTimeout(
      transport.send("checkForUpdate", undefined),
      400,
      "test guard",
    )
    expect(result).toEqual(settled)
  }, 1000)

  it("clears the timer on resolve so the call does not reject late after settling", async () => {
    const { promise, resolve } = deferred<unknown>()
    const rpc = {
      request: {
        someMethod: (_: unknown) => promise,
      },
    }
    const transport = createElectrobunTransport(rpc, {
      defaultTimeoutMs: 100,
    })
    // Resolve before the 100 ms timeout fires
    resolve({ ok: true, value: "done" })
    const result = await withTimeout(
      transport.send("someMethod", undefined),
      500,
      "test guard",
    )
    expect(result).toEqual({ ok: true, value: "done" })
    // Wait past the original timeout to confirm no late rejection leaks
    await new Promise((r) => setTimeout(r, 150))
    // If we reach here without an unhandled rejection the timer was cleared.
  }, 1000)
})
