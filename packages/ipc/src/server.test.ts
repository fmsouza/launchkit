import { describe, it, expect } from "bun:test"
import { createIpcServer } from "./server"
import type { ServerTransport } from "./server"
import type { IpcHandlers } from "./server"

const sampleView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai" as const,
  config: {},
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
}

/** A controllable transport: capture the handler, drive requests by hand. */
const fakeServerTransport = (): ServerTransport & {
  dispatch(method: string, payload: unknown): Promise<unknown>
} => {
  let handler: ((method: string, payload: unknown) => Promise<unknown>) | undefined
  return {
    onRequest: (h) => { handler = h },
    dispatch: (method, payload) => {
      if (!handler) throw new Error("no handler registered")
      return handler(method, payload)
    },
  }
}

describe("createIpcServer", () => {
  it("validates the payload then dispatches to the matching handler and returns its result", async () => {
    const transport = fakeServerTransport()
    const handlers: Pick<IpcHandlers, "getProviders"> = {
      getProviders: async () => [sampleView],
    }
    createIpcServer(handlers as IpcHandlers, transport)
    const out = await transport.dispatch("getProviders", undefined)
    expect(out).toEqual([sampleView])
  })

  it("rejects an unknown method with a handler-failed error and never invents a result", async () => {
    const transport = fakeServerTransport()
    createIpcServer({} as IpcHandlers, transport)
    await expect(transport.dispatch("noSuchMethod", {})).rejects.toThrow(/handler-failed/)
  })

  it("rejects an invalid payload before the handler runs", async () => {
    const transport = fakeServerTransport()
    let handlerRan = false
    const handlers: Pick<IpcHandlers, "addProvider"> = {
      addProvider: async () => { handlerRan = true; return sampleView },
    }
    createIpcServer(handlers as IpcHandlers, transport)
    await expect(transport.dispatch("addProvider", { name: "" })).rejects.toThrow(/validation-failed/)
    expect(handlerRan).toBe(false)
  })

  it("rejects with handler-failed when the handler throws", async () => {
    const transport = fakeServerTransport()
    const handlers: Pick<IpcHandlers, "getProxyStatus"> = {
      getProxyStatus: async () => { throw new Error("proxy probe failed") },
    }
    createIpcServer(handlers as IpcHandlers, transport)
    await expect(transport.dispatch("getProxyStatus", undefined)).rejects.toThrow(/proxy probe failed/)
  })

  it("rejects with validation-failed when a handler returns a result that fails its schema", async () => {
    const transport = fakeServerTransport()
    const handlers: Pick<IpcHandlers, "getProxyStatus"> = {
      // Missing `port` — invalid result shape.
      getProxyStatus: async () => ({ running: true } as never),
    }
    createIpcServer(handlers as IpcHandlers, transport)
    await expect(transport.dispatch("getProxyStatus", undefined)).rejects.toThrow(/validation-failed/)
  })

  it("consumes the raw secret on setProviderSecret and serializes a void (null) result", async () => {
    const transport = fakeServerTransport()
    let received: { providerId: string; field: string; value: string } | undefined
    const handlers: Pick<IpcHandlers, "setProviderSecret"> = {
      setProviderSecret: async (params) => { received = params; return null },
    }
    createIpcServer(handlers as IpcHandlers, transport)
    const out = await transport.dispatch("setProviderSecret", {
      providerId: "p_openai",
      field: "apiKey",
      value: "sk-secret",
    })
    expect(out).toBeNull() // void encoded as null; no value echoed back
    expect(received).toEqual({ providerId: "p_openai", field: "apiKey", value: "sk-secret" })
  })
})
