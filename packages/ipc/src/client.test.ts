import { describe, it, expect } from "bun:test"
import { createIpcClient } from "./client"
import type { ClientTransport } from "./client"
import { ProviderViewSchema } from "./provider-view"

const sampleView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
}

/** Records calls and replays a scripted reply (or throws) per method. */
const fakeTransport = (
  reply: (method: string, payload: unknown) => Promise<unknown>,
): ClientTransport & { calls: ReadonlyArray<{ method: string; payload: unknown }> } => {
  const calls: Array<{ method: string; payload: unknown }> = []
  return {
    calls,
    send: async (method, payload) => {
      calls.push({ method, payload })
      return reply(method, payload)
    },
  }
}

describe("createIpcClient", () => {
  it("validates params, sends, and returns Ok(result) when the response is valid", async () => {
    const transport = fakeTransport(async () => [sampleView])
    const client = createIpcClient(transport)
    const r = await client.getProviders(undefined)
    expect(r).toEqual({ ok: true, value: [ProviderViewSchema.parse(sampleView)] })
    expect(transport.calls).toEqual([{ method: "getProviders", payload: undefined }])
  })

  it("returns a validation-failed error and never sends when params are invalid", async () => {
    const transport = fakeTransport(async () => null)
    const client = createIpcClient(transport)
    // Missing required fields on addProvider params.
    const r = await client.addProvider({ name: "" } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("validation-failed")
    expect(transport.calls).toEqual([]) // short-circuited before send
  })

  it("returns a validation-failed error when the response fails the result schema", async () => {
    const transport = fakeTransport(async () => ({ not: "an array" }))
    const client = createIpcClient(transport)
    const r = await client.getProviders(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("validation-failed")
  })

  it("returns a transport-failed error when the transport rejects", async () => {
    const transport = fakeTransport(async () => { throw new Error("bridge down") })
    const client = createIpcClient(transport)
    const r = await client.getProxyStatus(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("transport-failed")
      expect(r.error.detail).toContain("bridge down")
    }
  })

  it("encodes a void result (null) as an Ok carrying null", async () => {
    const transport = fakeTransport(async () => null)
    const client = createIpcClient(transport)
    const r = await client.deleteProvider({ id: "p_openai" })
    expect(r).toEqual({ ok: true, value: null })
  })

  it("passes the secret value through on setProviderSecret and returns Ok(null)", async () => {
    const transport = fakeTransport(async () => null)
    const client = createIpcClient(transport)
    const r = await client.setProviderSecret({ providerId: "p_openai", field: "apiKey", value: "sk-secret" })
    expect(r).toEqual({ ok: true, value: null })
    expect(transport.calls[0]).toEqual({
      method: "setProviderSecret",
      payload: { providerId: "p_openai", field: "apiKey", value: "sk-secret" },
    })
  })
})
