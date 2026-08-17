import { describe, expect, it } from "bun:test"
import type { PluginId } from "@spectrum/types"
import { createIpcClient } from "./client"
import type { ContributedProviderView, ExtensionView } from "./extension-view"
import { createMemoryTransportPair } from "./fake-transport"
import type { IpcHandlers } from "./server"
import { createIpcServer } from "./server"

const wellFormedProvider: ContributedProviderView = {
  key: "plugin:acme",
  label: "Acme",
  status: "running",
  launchCommand: "/usr/local/bin/acme-server",
  launchArgs: ["--port", "{{port}}"],
  secretFieldNames: ["apiKey"],
}

const wellFormedView: ExtensionView = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  enabled: true,
  source: {
    kind: "git",
    url: "https://e.com/a.git",
    ref: "HEAD",
    commit: "c1",
  },
  unavailable: false,
  ignoredContributions: [],
  providers: [wellFormedProvider],
}

// ── Round-trip: the real server + client dispatch over createMemoryTransportPair,
// not a direct handler call. This is the ONLY place `.strict()` on ExtensionViewSchema/
// ContributedProviderViewSchema is actually exercised as a runtime guard — a direct
// `createIpcHandlers(ctx)` call in handlers.test.ts never goes through
// `createIpcServer`'s step-4 result validation, so a handler leaking an extra field there
// produces no test failure at all (proven below by round-tripping one on purpose).

describe("listExtensions round-trip", () => {
  it("carries a well-formed extension view across the wire untouched", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "listExtensions"> = {
      listExtensions: async () => [wellFormedView],
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listExtensions(undefined)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([wellFormedView])
  })

  // The core proof for review item 1: the reviewer's exact sabotage (a leaking
  // `instanceKey` on a `ContributedProviderView`) sent end-to-end and rejected by the
  // real server's result validation — not just by a schema unit test in isolation.
  it("rejects a listExtensions result whose contributed provider leaks an instanceKey", async () => {
    const pair = createMemoryTransportPair()
    const leaking = {
      ...wellFormedView,
      providers: [{ ...wellFormedProvider, instanceKey: "s_super_secret_key" }],
    }
    const handlers: Pick<IpcHandlers, "listExtensions"> = {
      listExtensions: async () => leaking as never,
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listExtensions(undefined)

    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The memory transport rethrows the server's IpcRequestError directly (no
      // serialization boundary), so the client sees it as transport-failed rather than
      // the structured validation-failed a real Electrobun bus would deliver — see the
      // identical note in list-provider-models.round-trip.test.ts. Either way it must
      // never be `ok: true` carrying the leaked field.
      expect(["handler-failed", "transport-failed"]).toContain(r.error.kind)
    }
  })

  it("rejects a listExtensions result carrying a resolved env map instead of the unrendered template", async () => {
    const pair = createMemoryTransportPair()
    const leaking = {
      ...wellFormedView,
      providers: [
        { ...wellFormedProvider, env: { ACME_API_KEY: "sk-live-leak" } },
      ],
    }
    const handlers: Pick<IpcHandlers, "listExtensions"> = {
      listExtensions: async () => leaking as never,
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listExtensions(undefined)

    expect(r.ok).toBe(false)
  })

  it("rejects a listExtensions result whose extension view carries a secrets map", async () => {
    const pair = createMemoryTransportPair()
    const leaking = { ...wellFormedView, secrets: { apiKey: "sk-live-leak" } }
    const handlers: Pick<IpcHandlers, "listExtensions"> = {
      listExtensions: async () => leaking as never,
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.listExtensions(undefined)

    expect(r.ok).toBe(false)
  })
})

describe("removeExtension round-trip", () => {
  it("carries the in-use refusal (not an ExtensionView[]) across the wire, naming the referencing providers", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "removeExtension"> = {
      removeExtension: async () => ({
        refused: { kind: "in-use", id: "acme", providerIds: ["prv_1"] },
      }),
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.removeExtension({ id: "acme" as PluginId })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        refused: { kind: "in-use", id: "acme", providerIds: ["prv_1"] },
      })
    }
  })

  it("carries the refreshed list across the wire on a successful removal", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "removeExtension"> = {
      removeExtension: async () => [],
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.removeExtension({ id: "acme" as PluginId })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })
})

describe("installExtension round-trip", () => {
  it("forwards install params and returns the refreshed list", async () => {
    const pair = createMemoryTransportPair()
    let received: unknown
    const handlers: Pick<IpcHandlers, "installExtension"> = {
      installExtension: async (params) => {
        received = params
        return [wellFormedView]
      },
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.installExtension({
      source: "https://e.com/a.git",
      mode: "link",
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([wellFormedView])
    expect(received).toEqual({ source: "https://e.com/a.git", mode: "link" })
  })

  it("rejects install params carrying an extra key (strict)", async () => {
    const pair = createMemoryTransportPair()
    const handlers: Pick<IpcHandlers, "installExtension"> = {
      installExtension: async () => [wellFormedView],
    }
    createIpcServer(handlers as IpcHandlers, pair.server)
    const client = createIpcClient(pair.client)

    const r = await client.installExtension({
      source: "https://e.com/a.git",
      secretValue: "sk-leak",
    } as never)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("validation-failed")
  })
})
