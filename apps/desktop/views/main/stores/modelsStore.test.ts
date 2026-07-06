import { describe, expect, it, mock } from "bun:test"
import type { ModelId, ModelRoute, ProviderId } from "@spectrum/types"
import { createFakeIpcClient } from "../test/fake-client"
import { createModelsStore } from "./modelsStore"

const route: ModelRoute = {
  id: "m_1" as ModelId,
  providerId: "p_openai" as ProviderId,
  providerModel: "gpt-4o",
  aliases: [],
}

describe("createModelsStore", () => {
  it("loads model routes via fetch", async () => {
    const store = createModelsStore({
      client: createFakeIpcClient({
        getModels: async () => ({ ok: true, value: [route] }),
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data).toEqual([route])
  })

  it("add calls addModel then invalidates", async () => {
    const getModels = mock(async () => ({ ok: true as const, value: [route] }))
    const client = createFakeIpcClient({
      getModels,
      addModel: async () => ({ ok: true as const, value: route }),
    })
    const store = createModelsStore({ client })
    await store.getState().fetch()
    await store.getState().add({
      providerId: "p_openai" as ProviderId,
      providerModel: "gpt-4o",
      aliases: [],
    })
    expect(client.calls.addModel.length).toBe(1)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it("remove calls deleteModel then invalidates", async () => {
    const getModels = mock(async () => ({ ok: true as const, value: [route] }))
    const client = createFakeIpcClient({
      getModels,
      deleteModel: async () => ({ ok: true as const, value: null }),
    })
    const store = createModelsStore({ client })
    await store.getState().fetch()
    await store.getState().remove("m_1" as ModelId)
    expect(client.calls.deleteModel[0]).toMatchObject({ id: "m_1" })
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it("sorts model routes by provider display name then model after fetch", async () => {
    const store = createModelsStore({
      client: createFakeIpcClient({
        getModels: async () => ({
          ok: true,
          value: [
            { id: "m_openai", providerId: "p_openai", providerModel: "gpt-4o" },
            {
              id: "m_sonnet",
              providerId: "p_anthropic",
              providerModel: "claude-sonnet",
            },
            {
              id: "m_haiku",
              providerId: "p_anthropic",
              providerModel: "claude-haiku",
            },
          ] as unknown as ModelRoute[],
        }),
      }),
      providerNameResolver: () => ({
        p_anthropic: "Anthropic",
        p_openai: "OpenAI",
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data?.map((m) => m.id)).toEqual([
      "m_haiku",
      "m_sonnet",
      "m_openai",
    ] as ModelId[])
  })

  it("falls back to providerId when the resolver returns an empty map", async () => {
    const store = createModelsStore({
      client: createFakeIpcClient({
        getModels: async () => ({
          ok: true,
          value: [
            { id: "m2", providerId: "p_zeta", providerModel: "z-model" },
            { id: "m1", providerId: "p_alpha", providerModel: "a-model" },
          ] as unknown as ModelRoute[],
        }),
      }),
      providerNameResolver: () => ({}),
    })
    await store.getState().fetch()
    expect(store.getState().data?.map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ] as ModelId[])
  })

  it("sorts by providerId fallback when no resolver is supplied", async () => {
    const store = createModelsStore({
      client: createFakeIpcClient({
        getModels: async () => ({
          ok: true,
          value: [
            { id: "m2", providerId: "p_zeta", providerModel: "z" },
            { id: "m1", providerId: "p_alpha", providerModel: "a" },
          ] as unknown as ModelRoute[],
        }),
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data?.map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ] as ModelId[])
  })
})
