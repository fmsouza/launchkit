import { describe, expect, it } from "bun:test"
import type { Config } from "@spectrum/config"
import { CURRENT_CONFIG_VERSION, SettingsSchema } from "@spectrum/config"
import { isErr } from "@spectrum/utils"
import { createRouter } from "./router"

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type ModelStub = {
  id: string
  providerId: string
  providerModel: string
  aliases?: string[]
}

const configWith = (models: ModelStub[]): Config =>
  ({
    version: CURRENT_CONFIG_VERSION,
    settings: SettingsSchema.parse({}),
    providers: [
      {
        id: "p1",
        name: "P1",
        sdkProvider: "openai",
        config: {},
        secrets: {},
      },
    ],
    models,
  }) as unknown as Config

const config = {
  version: 2,
  settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      sdkProvider: "openai",
      config: {},
      secrets: {},
      models: ["gpt-4o"],
    },
  ],
  models: [{ id: "mdl_fast", providerId: "openai", providerModel: "gpt-4o" }],
} as unknown as Config

// ---------------------------------------------------------------------------
// Existing tests (widened to assert routeId / resolvedVia)
// ---------------------------------------------------------------------------

describe("createRouter", () => {
  it("resolves a model id to its provider and provider model", () => {
    const r = createRouter(config).resolve("mdl_fast")
    expect(r.ok && r.value.providerModel).toBe("gpt-4o")
    expect(r.ok && r.value.provider.id).toBe<false | string>("openai")
    if (r.ok) expect(r.value.routeId).toBe("mdl_fast")
    if (r.ok) expect(r.value.resolvedVia).toBe("exact")
  })
  it("returns unknown-model when the id is not in the table", () => {
    const r2 = createRouter(config).resolve("nope")
    expect(isErr(r2)).toBe(true)
    if (isErr(r2))
      expect(r2.error).toEqual({ kind: "unknown-model", id: "nope" })
  })
  it("returns unknown-provider when a model points at a missing provider", () => {
    const bad = {
      ...config,
      models: [{ id: "mdl_x", providerId: "ghost", providerModel: "m" }],
    } as unknown as Config
    expect(createRouter(bad).resolve("mdl_x")).toEqual({
      ok: false,
      error: { kind: "unknown-provider", providerId: "ghost" },
    })
  })

  it("resolves against the latest config when given a getter (sees models added after construction)", () => {
    let current = { ...config, models: [] } as unknown as Config
    const router = createRouter(() => current)
    // Not present yet: a model added to config only after the proxy started.
    expect(isErr(router.resolve("mdl_fast"))).toBe(true)
    // The live config changes (e.g. the user adds a model in the GUI) — no rebuild needed.
    current = config
    const r = router.resolve("mdl_fast")
    expect(r.ok && r.value.providerModel).toBe("gpt-4o")
  })

  // -------------------------------------------------------------------------
  // Tolerant resolution tests (Task A2)
  // -------------------------------------------------------------------------

  it("resolves an exact model id with resolvedVia 'exact'", () => {
    const router = createRouter(
      configWith([{ id: "mdl_a", providerId: "p1", providerModel: "gpt-4o" }]),
    )
    const r = router.resolve("mdl_a")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("exact")
    if (r.ok) expect(r.value.routeId).toBe("mdl_a")
    if (r.ok) expect(r.value.providerModel).toBe("gpt-4o")
  })

  it("resolves a provider-native id to the route whose providerModel matches", () => {
    const router = createRouter(
      configWith([{ id: "mdl_a", providerId: "p1", providerModel: "gpt-4o" }]),
    )
    const r = router.resolve("gpt-4o")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("provider-model")
    if (r.ok) expect(r.value.routeId).toBe("mdl_a")
  })

  it("falls back to the session's selected model when the requested id is unknown", () => {
    const router = createRouter(
      configWith([
        { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
      ]),
    )
    const r = router.resolve("claude-haiku-4-5", { fallbackModelId: "mdl_sel" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("session-fallback")
    if (r.ok) expect(r.value.routeId).toBe("mdl_sel")
  })

  it("returns unknown-model when the id is unknown and no usable fallback is configured", () => {
    const router = createRouter(
      configWith([
        { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
      ]),
    )
    const r = router.resolve("nope", { fallbackModelId: "also-missing" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toEqual({ kind: "unknown-model", id: "nope" })
  })

  it("prefers an exact match over the session fallback", () => {
    const router = createRouter(
      configWith([
        { id: "mdl_a", providerId: "p1", providerModel: "gpt-4o" },
        { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
      ]),
    )
    const r = router.resolve("mdl_a", { fallbackModelId: "mdl_sel" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("exact")
  })

  // -------------------------------------------------------------------------
  // Alias / tier resolution tests (Task B3)
  // -------------------------------------------------------------------------

  it("maps a requested alias to the route that claims it", () => {
    const router = createRouter(
      configWith([
        {
          id: "mdl_big",
          providerId: "p1",
          providerModel: "claude-opus",
          aliases: ["opus", "big"],
        },
        {
          id: "mdl_small",
          providerId: "p1",
          providerModel: "claude-haiku-4-5",
          aliases: ["haiku", "small"],
        },
      ]),
    )
    const r = router.resolve("haiku", { fallbackModelId: "mdl_big" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("alias")
    if (r.ok) expect(r.value.routeId).toBe("mdl_small")
  })

  it("reduces a concrete model id to its family keyword to match an alias", () => {
    const router = createRouter(
      configWith([
        {
          id: "mdl_small",
          providerId: "p1",
          providerModel: "claude-haiku-4-5",
          aliases: ["haiku"],
        },
        {
          id: "mdl_big",
          providerId: "p1",
          providerModel: "claude-opus",
          aliases: ["opus"],
        },
      ]),
    )
    const r = router.resolve("claude-haiku-4-5-20251001", {
      fallbackModelId: "mdl_big",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("alias")
    if (r.ok) expect(r.value.routeId).toBe("mdl_small")
  })

  it("collapses to the session model when no alias claims the requested tier", () => {
    const router = createRouter(
      configWith([
        {
          id: "mdl_big",
          providerId: "p1",
          providerModel: "claude-opus",
          aliases: [],
        },
      ]),
    )
    const r = router.resolve("claude-haiku-4-5", { fallbackModelId: "mdl_big" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resolvedVia).toBe("session-fallback")
  })

  // -------------------------------------------------------------------------
  // Wire alias resolution (Task 9): the CLI was handed `claude-spectrum-<routeId>`
  // so it treats the model as multimodal-capable; strip the prefix back to the
  // exact route.
  // -------------------------------------------------------------------------

  it("resolves a claude-spectrum wire alias to its exact route", () => {
    const router = createRouter(
      configWith([
        {
          id: "mdl_vis",
          providerId: "p1",
          providerModel: "llava:13b",
          aliases: [],
        },
      ]),
    )
    const r = router.resolve("claude-spectrum-mdl_vis")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.routeId).toBe("mdl_vis")
      expect(r.value.resolvedVia).toBe("wire-alias")
    }
  })

  it("falls through the normal chain when the wire-alias suffix matches no route", () => {
    const router = createRouter(
      configWith([
        {
          id: "mdl_a",
          providerId: "p1",
          providerModel: "x",
          aliases: ["haiku"],
        },
      ]),
    )
    // Suffix unknown, but the WHOLE id contains "haiku" → family/alias step still applies.
    const r = router.resolve("claude-spectrum-haiku-unknown", {
      fallbackModelId: "mdl_a",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.routeId).toBe("mdl_a")
  })
})
