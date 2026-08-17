import { describe, expect, it, mock } from "bun:test"
import { createProviderRegistry, getDescriptor } from "@spectrum/providers"
import type { ProviderDescriptor } from "@spectrum/providers"
import {
  createInMemoryKeychainBackend,
  createSecretStore,
} from "@spectrum/secrets"
import type { Provider, ProviderKey } from "@spectrum/types"
import { createSequentialIdGen, err, ok } from "@spectrum/utils"
import { createProviderFactory } from "./factory"
import { defaultResolveBaseUrl } from "./resolve-base-url"

// Real (builtins-only) registry shared by every test below — descriptor injection is the point
// of this task, so tests exercise it through a real registry rather than duplicating the catalog.
const registry = createProviderRegistry()

const makeProvider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p1",
    name: "OpenAI",
    sdkProvider: "openai",
    config: {},
    secrets: {},
    models: [],
    ...over,
  }) as Provider

describe("createProviderFactory", () => {
  it("calls the SDK create fn with the resolved api key and returns a model handle", async () => {
    const store = createSecretStore({
      backend: createInMemoryKeychainBackend(),
      idGen: createSequentialIdGen(),
    })
    const set = await store.set("sk-live")
    const ref = set.ok ? set.value : { ref: "x" }
    const create = mock((cfg: { apiKey: string }) => ({
      provider: "openai",
      apiKey: cfg.apiKey,
    }))
    const loadSdk = mock(async (_d: ProviderDescriptor) => ({ create }))
    const factory = createProviderFactory({
      secretStore: store,
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const r = await factory.getModel(
      makeProvider({ secrets: { apiKey: ref } }),
      "gpt-4o",
    )
    expect(r.ok).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]?.[0] as { apiKey: string }).apiKey).toBe(
      "sk-live",
    )
  })
  it("reuses a cached SDK instance when the same provider config is requested twice", async () => {
    const create = mock(() => ({ ok: true }))
    const loadSdk = mock(async () => ({ create }))
    const store = createSecretStore({
      backend: createInMemoryKeychainBackend(),
      idGen: createSequentialIdGen(),
    })
    const factory = createProviderFactory({
      secretStore: store,
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const p = makeProvider()
    await factory.getModel(p, "m")
    await factory.getModel(p, "m")
    expect(loadSdk).toHaveBeenCalledTimes(1)
  })
  it("returns unsupported-provider when loadSdk has no entry for the sdkProvider", async () => {
    const factory = createProviderFactory({
      secretStore: createSecretStore({
        backend: createInMemoryKeychainBackend(),
        idGen: createSequentialIdGen(),
      }),
      loadSdk: async () => {
        throw new Error("no module")
      },
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const r = await factory.getModel(
      makeProvider({ sdkProvider: "cohere" }),
      "m",
    )
    expect(r.ok === false && r.error.kind).toBe("unsupported-provider")
  })
  it("passes descriptor-mapped options (baseURL + Authorization header) to the SDK for ollama cloud", async () => {
    const captured: Record<string, unknown>[] = []
    const loadSdk = async () => ({
      create: (cfg: Record<string, unknown>) => {
        captured.push(cfg)
        return (id: string) => ({ id })
      },
    })
    const secretStore: import("@spectrum/secrets").SecretStore = {
      set: async () => ({ ok: true as const, value: { ref: "r" } }),
      get: async () => ({ ok: true as const, value: "cloud-key" }),
      delete: async () => ({ ok: true as const, value: undefined }),
      has: async () => true,
    }
    const factory = createProviderFactory({
      secretStore,
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const provider: Provider = {
      id: "p_1" as Provider["id"],
      name: "Ollama Cloud",
      sdkProvider: "ollama",
      config: {},
      secrets: { apiKey: { ref: "r" } },
      models: [],
    }
    const r = await factory.getModel(provider, "llama3.2")
    expect(r.ok).toBe(true)
    expect(captured[0]).toEqual({
      baseURL: "https://ollama.com/api",
      headers: { Authorization: "Bearer cloud-key" },
    })
  })
})

describe("createProviderFactory resolveBaseUrl seam", () => {
  it("passes the resolved base url to the SDK when resolveBaseUrl supplies one", async () => {
    const captured: Record<string, unknown>[] = []
    const loadSdk = mock(async (_d: ProviderDescriptor) => ({
      create: (cfg: Record<string, unknown>) => {
        captured.push(cfg)
        return (id: string) => ({ id })
      },
    }))
    const factory = createProviderFactory({
      secretStore: createSecretStore({
        backend: createInMemoryKeychainBackend(),
        idGen: createSequentialIdGen(),
      }),
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: async () => ok("http://127.0.0.1:41111"),
    })

    const r = await factory.getModel(makeProvider(), "gpt-4o")

    expect(r.ok).toBe(true)
    expect(captured[0]?.baseURL).toBe("http://127.0.0.1:41111")
  })

  it("fails the model build when resolveBaseUrl fails", async () => {
    const loadSdk = mock(async (_d: ProviderDescriptor) => ({
      create: () => ({}),
    }))
    const factory = createProviderFactory({
      secretStore: createSecretStore({
        backend: createInMemoryKeychainBackend(),
        idGen: createSequentialIdGen(),
      }),
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: async () =>
        err({ kind: "provider-failed", detail: "extension acme not running" }),
    })

    const r = await factory.getModel(makeProvider(), "gpt-4o")

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("provider-failed")
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it("does not reuse a cached instance when the resolved base url changes", async () => {
    // Spec §8.3: a supervised plugin that restarts comes back on a NEW port. The resolved base
    // url is part of the cache key, so the second call must build a fresh SDK instance pointed
    // at the new port rather than serving the cached one bound to the dead one.
    const captured: Record<string, unknown>[] = []
    const loadSdk = mock(async (_d: ProviderDescriptor) => ({
      create: (cfg: Record<string, unknown>) => {
        captured.push(cfg)
        return (id: string) => ({ id })
      },
    }))
    const urls = ["http://127.0.0.1:41111", "http://127.0.0.1:41222"]
    let call = 0
    const factory = createProviderFactory({
      secretStore: createSecretStore({
        backend: createInMemoryKeychainBackend(),
        idGen: createSequentialIdGen(),
      }),
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: async () => ok(urls[call++]),
    })

    const p = makeProvider()
    const first = await factory.getModel(p, "m")
    const second = await factory.getModel(p, "m")

    expect(first.ok && second.ok).toBe(true)
    expect(loadSdk).toHaveBeenCalledTimes(2)
    expect(captured.map((c) => c.baseURL)).toEqual(urls)
  })
})

describe("createProviderFactory.getModelFromResolved", () => {
  it("builds a model from inline resolved secret values without touching the SecretStore", async () => {
    const captured: Array<Record<string, unknown>> = []
    const loadSdk = mock(async (_d: ProviderDescriptor) => ({
      create: (cfg: Record<string, unknown>) => {
        captured.push(cfg)
        return (id: string) => ({ id })
      },
    }))
    // A SecretStore whose .get throws — proves the resolved path never calls it.
    const secretStore: import("@spectrum/secrets").SecretStore = {
      set: async () => ({ ok: true as const, value: { ref: "r" } }),
      get: async () => {
        throw new Error("getModelFromResolved must not read the keychain")
      },
      delete: async () => ({ ok: true as const, value: undefined }),
      has: async () => true,
    }
    const factory = createProviderFactory({
      secretStore,
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })

    const r = await factory.getModelFromResolved({
      sdkProvider: "openai",
      config: {},
      secrets: { apiKey: "sk-inline" },
      providerModel: "gpt-4o",
    })

    expect(r.ok).toBe(true)
    // The inline apiKey reached the SDK options (openai maps apiKey as an option).
    expect(captured[0]?.apiKey).toBe("sk-inline")
    // loadSdk was called with the descriptor for the resolved sdkProvider.
    expect(loadSdk).toHaveBeenCalledWith(getDescriptor("openai"))
    // The returned model handle carries the requested model id.
    expect(r.ok && (r.value as { id: string }).id).toBe("gpt-4o")
  })
  it("rejects a plugin-contributed provider with unsupported-provider error", async () => {
    const store = createSecretStore({
      backend: createInMemoryKeychainBackend(),
      idGen: createSequentialIdGen(),
    })
    const loadSdk = mock(async () => ({ create: () => ({}) }))
    const factory = createProviderFactory({
      secretStore: store,
      loadSdk,
      getDescriptor: registry.get,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const pluginProvider = makeProvider({
      sdkProvider: "plugin:my-provider" as ProviderKey,
    })
    const r = await factory.getModel(pluginProvider, "some-model")
    expect(r.ok).toBe(false)
    if (!r.ok && "sdkProvider" in r.error) {
      expect(r.error.kind).toBe("unsupported-provider")
      expect(r.error.sdkProvider).toBe("plugin:my-provider")
    }
  })
  it("reports unsupported-provider when the injected getDescriptor claims no descriptor, without ever calling loadSdk", async () => {
    const store = createSecretStore({
      backend: createInMemoryKeychainBackend(),
      idGen: createSequentialIdGen(),
    })
    const loadSdk = mock(async () => ({ create: () => ({}) }))
    const factory = createProviderFactory({
      secretStore: store,
      loadSdk,
      getDescriptor: () => undefined,
      resolveBaseUrl: defaultResolveBaseUrl,
    })
    const r = await factory.getModelFromResolved({
      sdkProvider: "plugin:gone",
      config: {},
      secrets: {},
      providerModel: "m",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-provider")
    expect(loadSdk).not.toHaveBeenCalled()
  })
})
