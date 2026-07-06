import { describe, expect, it, mock } from "bun:test"
import type { ProviderView } from "@spectrum/ipc"
import type { ProviderId } from "@spectrum/types"
import { createFakeIpcClient } from "../test/fake-client"
import { createProvidersStore } from "./providersStore"

const view = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
} as unknown as ProviderView

describe("createProvidersStore", () => {
  it("loads provider views via fetch", async () => {
    const store = createProvidersStore({
      client: createFakeIpcClient({
        getProviders: async () => ({ ok: true, value: [view] }),
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data).toEqual([view])
  })

  it("sorts provider views by name after fetch", async () => {
    const zeta = {
      ...view,
      id: "p_zeta",
      name: "Zeta",
    } as unknown as ProviderView
    const alpha = {
      ...view,
      id: "p_alpha",
      name: "Alpha",
    } as unknown as ProviderView
    const store = createProvidersStore({
      client: createFakeIpcClient({
        getProviders: async () => ({ ok: true, value: [zeta, alpha] }),
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data).toEqual([alpha, zeta])
  })

  it("add calls addProvider then invalidates (refetches)", async () => {
    const getProviders = mock(async () => ({
      ok: true as const,
      value: [view],
    }))
    const client = createFakeIpcClient({
      getProviders,
      addProvider: async () => ({ ok: true as const, value: view }),
    })
    const store = createProvidersStore({ client })
    await store.getState().fetch()
    await store.getState().add({
      name: "OpenAI",
      sdkProvider: "openai",
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })
    expect(client.calls.addProvider.length).toBe(1)
    expect(getProviders).toHaveBeenCalledTimes(2)
  })

  it("setSecret forwards to setProviderSecret then invalidates", async () => {
    const getProviders = mock(async () => ({
      ok: true as const,
      value: [view],
    }))
    const client = createFakeIpcClient({
      getProviders,
      setProviderSecret: async () => ({ ok: true as const, value: null }),
    })
    const store = createProvidersStore({ client })
    await store.getState().fetch()
    await store.getState().setSecret({
      providerId: "p_openai" as ProviderId,
      field: "apiKey",
      value: "sk-123",
    })
    expect(client.calls.setProviderSecret[0]).toMatchObject({ field: "apiKey" })
    expect(getProviders).toHaveBeenCalledTimes(2)
  })
})
