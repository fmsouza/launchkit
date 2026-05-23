import { describe, it, expect } from "bun:test"
import { createFakeIpcClient } from "./fake-client"

describe("createFakeIpcClient", () => {
  it("returns the scripted Ok value when a stubbed method is called", async () => {
    const client = createFakeIpcClient({
      getProxyStatus: async () => ({ ok: true, value: { running: true, port: 4000 } }),
    })
    const r = await client.getProxyStatus(undefined)
    expect(r).toEqual({ ok: true, value: { running: true, port: 4000 } })
  })

  it("records the params each call was made with when invoked", async () => {
    const client = createFakeIpcClient({
      setProviderSecret: async () => ({ ok: true, value: null }),
    })
    await client.setProviderSecret({ providerId: "p_openai", field: "apiKey", value: "sk-x" })
    expect(client.calls.setProviderSecret).toEqual([
      { providerId: "p_openai", field: "apiKey", value: "sk-x" },
    ])
  })

  it("returns a handler-failed Result when an unstubbed method is called", async () => {
    const client = createFakeIpcClient({})
    const r = await client.getProviders(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("handler-failed")
  })
})
