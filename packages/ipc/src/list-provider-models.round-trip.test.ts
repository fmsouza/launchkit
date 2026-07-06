import { describe, expect, it } from "bun:test"
import type { ProviderId } from "@spectrum/types"
import { createIpcClient } from "./client"
import { createMemoryTransportPair } from "./fake-transport"
import {
  ListProviderModelsParamsSchema,
  ListProviderModelsResultSchema,
} from "./methods"
import type { IpcHandlers } from "./server"
import { createIpcServer } from "./server"

// ── Schema unit tests ─────────────────────────────────────────────────────────

describe("ListProviderModelsParamsSchema", () => {
  it("parses a valid providerId", () => {
    const result = ListProviderModelsParamsSchema.parse({
      providerId: "p_openai" as ProviderId,
    })
    expect(result).toEqual({ providerId: "p_openai" as ProviderId })
  })

  it("rejects extra keys (strict)", () => {
    expect(
      ListProviderModelsParamsSchema.safeParse({
        providerId: "p_openai" as ProviderId,
        extra: 1,
      }).success,
    ).toBe(false)
  })

  it("rejects missing providerId", () => {
    expect(ListProviderModelsParamsSchema.safeParse({}).success).toBe(false)
  })
})

describe("ListProviderModelsResultSchema", () => {
  it("parses a result with a list of model objects (id + optional attachments)", () => {
    const result = ListProviderModelsResultSchema.parse({
      models: [
        { id: "gpt-4o" },
        { id: "llava:13b", attachments: { image: true, pdf: false } },
      ],
    })
    expect(result).toEqual({
      models: [
        { id: "gpt-4o" },
        { id: "llava:13b", attachments: { image: true, pdf: false } },
      ],
    })
  })

  it("parses a result with an empty models array", () => {
    const result = ListProviderModelsResultSchema.parse({ models: [] })
    expect(result).toEqual({ models: [] })
  })

  it("rejects extra keys (strict)", () => {
    expect(
      ListProviderModelsResultSchema.safeParse({
        models: [{ id: "gpt-4o" }],
        extra: 1,
      }).success,
    ).toBe(false)
  })

  it("rejects a result missing models", () => {
    expect(ListProviderModelsResultSchema.safeParse({}).success).toBe(false)
  })

  it("rejects objects without an id string", () => {
    expect(
      ListProviderModelsResultSchema.safeParse({ models: [1, 2] }).success,
    ).toBe(false)
  })
})

// ── Round-trip tests ──────────────────────────────────────────────────────────

describe("listProviderModels round-trip", () => {
  it("forwards providerId and returns the discovered models list", async () => {
    const pair = createMemoryTransportPair()
    let receivedProviderId: ProviderId | undefined

    const handlers: Pick<IpcHandlers, "listProviderModels"> = {
      listProviderModels: async ({ providerId }) => {
        receivedProviderId = providerId
        return {
          models: [{ id: "llama3.2" }, { id: "mistral:latest" }],
        }
      },
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listProviderModels({
      providerId: "p_ollama" as ProviderId,
    })

    expect(r).toEqual({
      ok: true,
      value: {
        models: [{ id: "llama3.2" }, { id: "mistral:latest" }],
      },
    })
    expect(receivedProviderId).toBe("p_ollama" as ProviderId)
  })

  it("returns an empty models array when the provider has no models", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "listProviderModels"> = {
      listProviderModels: async () => ({ models: [] }),
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listProviderModels({
      providerId: "p_openai" as ProviderId,
    })

    expect(r).toEqual({ ok: true, value: { models: [] } })
  })

  it("surfaces an IpcError when the handler throws (transport-failed over memory transport)", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "listProviderModels"> = {
      listProviderModels: async () => {
        throw new Error("provider unreachable")
      },
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listProviderModels({
      providerId: "p_openai" as ProviderId,
    })

    // The memory transport rethrows the IpcRequestError directly, so the client
    // surfaces it as transport-failed (the real Electrobun bus would serialize
    // handler-failed — both are IpcError variants the UI handles uniformly).
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(["handler-failed", "transport-failed"]).toContain(r.error.kind)
      expect(r.error.detail).toContain("provider unreachable")
    }
  })
})
