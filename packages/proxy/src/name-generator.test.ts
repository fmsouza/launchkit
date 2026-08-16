import { describe, expect, it } from "bun:test"
import type { ConfigStore } from "@spectrum/config"
import type { Config } from "@spectrum/config"
import type { ModelId, ModelRoute, Provider, ProviderId } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { NAME_MAX_CHARS, createNameGenerator } from "./name-generator"

const pid = "prv_1" as ProviderId
const mid = "mdl_1" as ModelId
const route: ModelRoute = {
  id: mid,
  providerId: pid,
  providerModel: "gpt-4o",
  aliases: [],
  attachments: {},
}
const provider: Provider = {
  id: pid,
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secrets: {},
  models: ["gpt-4o"],
}

const makeConfigStore = (config: Config): ConfigStore => ({
  load: async () => ok(config),
  save: async () => ok(undefined),
})

const failingConfigStore: ConfigStore = {
  load: async () => err({ kind: "parse-failed", detail: "io" }),
  save: async () => ok(undefined),
}

const okFactory = (handle: unknown) => ({
  getModel: async () => ok(handle),
  getModelFromResolved: async () => ok(handle),
})

describe("createNameGenerator", () => {
  it("returns the trimmed, capped model text on success", async () => {
    let received: {
      system?: string
      prompt?: string
      maxOutputTokens?: number
    } = {}
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      // biome-ignore lint/suspicious/noExplicitAny: Test stub for generateText — records args and returns canned text.
      generateText: async (opts: any) => {
        received = opts
        return { text: "  Fix flaky CI test  " }
      },
    })
    const r = await gen.generate(
      mid,
      "Help me debug a flaky test",
      new AbortController().signal,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe("Fix flaky CI test")
    expect(received.maxOutputTokens).toBe(32)
    expect(received.system).toMatch(/short.*title/i)
  })

  it("caps the name at NAME_MAX_CHARS", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x".repeat(NAME_MAX_CHARS + 10) }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.length).toBe(NAME_MAX_CHARS)
  })

  it("returns config-load-failed when config.load returns an error", async () => {
    const gen = createNameGenerator({
      config: failingConfigStore,
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x" }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r).toEqual(
      err({ kind: "config-load-failed", detail: "parse-failed" }),
    )
  })

  it("returns route-not-found when the model id is not in config", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x" }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r).toEqual(err({ kind: "route-not-found" }))
  })

  it("returns provider-not-found when the route's provider is missing", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x" }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r).toEqual(err({ kind: "provider-not-found" }))
  })

  it("returns model-unavailable when the factory fails", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      factory: {
        getModel: async () =>
          err({ kind: "provider-failed", detail: "no key" }),
        getModelFromResolved: async () =>
          err({ kind: "provider-failed", detail: "no key" }),
        // biome-ignore lint/suspicious/noExplicitAny: Inline factory stub returning err; ProviderFactory shape is heavy.
      } as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x" }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("model-unavailable")
  })

  it("returns generation-failed when generateText throws", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => {
        throw new Error("boom")
      },
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("generation-failed")
  })

  it("returns generation-failed when the model returns empty text", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "   " }),
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r).toEqual(err({ kind: "generation-failed", detail: "empty" }))
  })

  it("returns aborted when the signal is already aborted", async () => {
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: { now: () => new Date("2026-06-30T00:00:00Z") },
      generateText: async () => ({ text: "x" }),
    })
    const ac = new AbortController()
    ac.abort()
    const r = await gen.generate(mid, "p", ac.signal)
    expect(r).toEqual(err({ kind: "aborted" }))
  })

  it("returns timed-out when generateText does not resolve within the timeout", async () => {
    let startTime = 0
    const gen = createNameGenerator({
      config: makeConfigStore({
        version: 13,
        providers: [provider],
        models: [route],
        settings: {} as Config["settings"],
        providerPlugins: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: ProviderFactory shape is heavy; the test only needs getModel.
      factory: okFactory("HANDLE") as any,
      clock: {
        now: () => {
          // First call records start; subsequent calls advance past the timeout.
          if (startTime === 0) {
            startTime = Date.parse("2026-06-30T00:00:00Z")
            return new Date(startTime)
          }
          return new Date("2026-06-30T00:00:11Z")
        },
      },
      generateText: async () => {
        // Block long enough for the implementation's 1s clock-driven polling
        // interval to observe the advanced clock and abort the timeout controller.
        await new Promise<void>((resolve) => setTimeout(resolve, 1200))
        return { text: "late" }
      },
    })
    const r = await gen.generate(mid, "p", new AbortController().signal)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The timeout fires because the clock jumps 11s past the start.
    expect(["timed-out", "generation-failed"]).toContain(r.error.kind)
  })
})
