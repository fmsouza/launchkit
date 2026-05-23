import { describe, it, expect, mock } from "bun:test"
import { createProviderFactory } from "./factory"
import { createSecretStore, createInMemoryKeychainBackend } from "@launchkit/secrets"
import { createSequentialIdGen } from "@launchkit/utils"
import type { Provider } from "@launchkit/types"

const makeProvider = (over: Partial<Provider> = {}): Provider => ({
  id: "p1", name: "OpenAI", sdkProvider: "openai", config: {}, secrets: {}, models: [],
  ...over,
} as Provider)

describe("createProviderFactory", () => {
  it("calls the SDK create fn with the resolved api key and returns a model handle", async () => {
    const store = createSecretStore({ backend: createInMemoryKeychainBackend(), idGen: createSequentialIdGen() })
    const set = await store.set("sk-live")
    const ref = set.ok ? set.value : { ref: "x" }
    const create = mock((cfg: { apiKey: string }) => ({ provider: "openai", apiKey: cfg.apiKey }))
    const loadSdk = mock(async (_p: string) => ({ create }))
    const factory = createProviderFactory({ secretStore: store, loadSdk })
    const r = await factory.getModel(makeProvider({ secrets: { apiKey: ref } }), "gpt-4o")
    expect(r.ok).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]?.[0] as { apiKey: string }).apiKey).toBe("sk-live")
  })
  it("reuses a cached SDK instance when the same provider config is requested twice", async () => {
    const create = mock(() => ({ ok: true }))
    const loadSdk = mock(async () => ({ create }))
    const store = createSecretStore({ backend: createInMemoryKeychainBackend(), idGen: createSequentialIdGen() })
    const factory = createProviderFactory({ secretStore: store, loadSdk })
    const p = makeProvider()
    await factory.getModel(p, "m"); await factory.getModel(p, "m")
    expect(loadSdk).toHaveBeenCalledTimes(1)
  })
  it("returns unsupported-provider when loadSdk has no entry for the sdkProvider", async () => {
    const factory = createProviderFactory({
      secretStore: createSecretStore({ backend: createInMemoryKeychainBackend(), idGen: createSequentialIdGen() }),
      loadSdk: async () => { throw new Error("no module") },
    })
    const r = await factory.getModel(makeProvider({ sdkProvider: "cohere" }), "m")
    expect(r.ok === false && r.error.kind).toBe("unsupported-provider")
  })
})
