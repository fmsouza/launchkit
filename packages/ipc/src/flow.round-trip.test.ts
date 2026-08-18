import { describe, expect, it } from "bun:test"
import { createIpcClient } from "./client"
import { createMemoryTransportPair } from "./fake-transport"
import type { FlowStepViewData } from "./flow-view"
import type { IpcHandlers } from "./server"
import { createIpcServer } from "./server"

// ── Round-trip: the real server + client over createMemoryTransportPair. This is the ONLY
// place `.strict()` on the sanitized `done` member is exercised as a runtime guard on the
// path a leak would actually take — a direct `createIpcHandlers(ctx)` call in apps/desktop
// never reaches `createIpcServer`'s step-4 result validation, so a handler that echoed
// `done.secrets` there would produce no failure at all.

const startParams = {
  providerKey: "plugin:acme",
  flowId: "signin",
  context: "create" as const,
  config: {},
}

const wire = (
  step: unknown,
  toast?: unknown,
): Pick<IpcHandlers, "startProviderFlow"> => ({
  startProviderFlow: async () =>
    ({
      sessionId: "fs_1",
      step,
      ...(toast === undefined ? {} : { toast }),
    }) as never,
})

const call = async (
  handlers: Pick<IpcHandlers, "startProviderFlow">,
): Promise<
  ReturnType<ReturnType<typeof createIpcClient>["startProviderFlow"]>
> => {
  const pair = createMemoryTransportPair()
  createIpcServer(handlers as IpcHandlers, pair.server)
  return createIpcClient(pair.client).startProviderFlow(startParams)
}

describe("startProviderFlow round-trip", () => {
  it("carries a well-formed form step across the wire untouched", async () => {
    const step: FlowStepViewData = {
      kind: "form",
      title: "Sign in",
      fields: [
        { name: "token", label: "Token", kind: "password", required: true },
      ],
    }
    const r = await call(wire(step))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ sessionId: "fs_1", step })
  })

  it("carries a toast alongside the step when the plugin sent one", async () => {
    const r = await call(
      wire(
        { kind: "done", message: "Signed in" },
        { tone: "success", message: "ok" },
      ),
    )
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value).toEqual({
        sessionId: "fs_1",
        step: { kind: "done", message: "Signed in" },
        toast: { tone: "success", message: "ok" },
      })
  })

  // The core proof: a `done` step that still carries the plugin's plaintext secrets is
  // REJECTED by the real server's result validation rather than delivered to the renderer.
  // The payload is a complete, otherwise-valid result object (not a bare step) so validation
  // reaches the `done` member's `.strict()` instead of failing at the top level for the wrong
  // reason — the precise trap `extension-view.round-trip.test.ts` documents.
  it("rejects a startProviderFlow result whose done step leaks the plugin's secrets", async () => {
    const r = await call(
      wire({
        kind: "done",
        message: "Signed in",
        secrets: { apiKey: "sk-leaked" },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The memory transport RETHROWS the server's IpcRequestError instead of serializing it,
      // so the client reports `transport-failed` wrapping the server's message — the same note
      // `extension-view.round-trip.test.ts` carries. Asserting the detail (not just `ok:false`)
      // is what proves the RESULT schema rejected it, and names the offending key, rather than
      // the call having failed for some unrelated reason.
      expect(r.error.detail).toContain("validation-failed")
      expect(r.error.detail).toContain("secrets")
      expect(JSON.stringify(r)).not.toContain("sk-leaked")
    }
  })

  it("rejects a startProviderFlow result whose done step leaks the resolved config", async () => {
    const r = await call(
      wire({ kind: "done", config: { serverUrl: "http://127.0.0.1:9000" } }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toContain("validation-failed")
      expect(r.error.detail).toContain("config")
    }
  })

  // The envelope's own `.strict()`, not the step's: a handler that attached the flow's
  // instance key (or its env) BESIDE the step would leak just as effectively.
  it("rejects a startProviderFlow result carrying a field beside the step", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "startProviderFlow"> = {
      startProviderFlow: async () =>
        ({
          sessionId: "fs_1",
          step: { kind: "done", message: "Signed in" },
          instanceKey: "flow:acme:nonce-leak",
        }) as never,
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const r = await createIpcClient(pair.client).startProviderFlow(startParams)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toContain("validation-failed")
      expect(JSON.stringify(r)).not.toContain("nonce-leak")
    }
  })

  it("rejects a startProviderFlow param object carrying an unknown field", async () => {
    const pair = createMemoryTransportPair()
    createIpcServer(wire({ kind: "done" }) as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)
    const r = await client.startProviderFlow({
      ...startParams,
      hostToken: "t",
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("validation-failed")
  })
})

describe("advanceProviderFlow round-trip", () => {
  it("carries a stepless response across the wire when nothing changed", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "advanceProviderFlow"> = {
      advanceProviderFlow: async () => ({ sessionId: "fs_1" }),
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const r = await createIpcClient(pair.client).advanceProviderFlow({
      sessionId: "fs_1",
      result: { kind: "poll" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ sessionId: "fs_1" })
  })

  it("rejects an advance whose result kind is not part of the flow protocol", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "advanceProviderFlow"> = {
      advanceProviderFlow: async () => ({ sessionId: "fs_1" }),
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const r = await createIpcClient(pair.client).advanceProviderFlow({
      sessionId: "fs_1",
      result: { kind: "resume" },
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("validation-failed")
  })
})
