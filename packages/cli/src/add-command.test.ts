import { describe, expect, it } from "bun:test"
import { defaultConfig } from "@spectrum/config"
import type { ProviderId } from "@spectrum/types"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"

describe("add provider", () => {
  it("appends a provider with empty secrets and saves the config", async () => {
    const deps = makeFakeDeps()
    const result = await runCli(deps)([
      "add",
      "provider",
      "--id",
      "p_openai",
      "--name",
      "OpenAI",
      "--sdk",
      "openai",
      "--model",
      "gpt-4o,gpt-4o-mini",
    ])
    expect(result).toEqual({ ok: true, value: undefined })

    const loaded = await deps.config.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const added = loaded.value.providers.find((p) => p.id === "p_openai")
    expect(added?.name).toBe("OpenAI")
    expect(added?.sdkProvider).toBe("openai")
    expect(added?.models).toEqual(["gpt-4o", "gpt-4o-mini"])
    // SECURITY: the CLI never sets secret values — secrets start empty.
    expect(added?.secrets).toEqual({})
  })

  it("creates a provider with an empty models array when no --model flag is given", async () => {
    const deps = makeFakeDeps()
    await runCli(deps)([
      "add",
      "provider",
      "--id",
      "p_x",
      "--name",
      "X",
      "--sdk",
      "anthropic",
    ])
    const loaded = await deps.config.load()
    expect(loaded.ok && loaded.value.providers[0]?.models).toEqual([])
  })

  it("returns a usage error when a required provider flag is missing", async () => {
    const result = await runCli(makeFakeDeps())([
      "add",
      "provider",
      "--id",
      "p_x",
      "--name",
      "X",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("returns a usage error when --sdk is not a known SDK provider", async () => {
    const result = await runCli(makeFakeDeps())([
      "add",
      "provider",
      "--id",
      "p_x",
      "--name",
      "X",
      "--sdk",
      "not-a-real-sdk",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("accepts a plugin provider key when adding a provider", async () => {
    const result = await runCli(makeFakeDeps())([
      "add",
      "provider",
      "--id",
      "p_acme",
      "--name",
      "Acme",
      "--sdk",
      "plugin:acme",
    ])
    expect(result).toEqual({ ok: true, value: undefined })
  })

  it("returns a failed error when the provider id already exists", async () => {
    const seeded = {
      ...defaultConfig(),
      providers: [
        {
          id: "p_openai" as never,
          name: "OpenAI",
          sdkProvider: "openai" as const,
          config: {},
          secrets: {},
          models: [],
        },
      ],
    }
    const result = await runCli(makeFakeDeps({ initialConfig: seeded }))([
      "add",
      "provider",
      "--id",
      "p_openai",
      "--name",
      "Dup",
      "--sdk",
      "openai",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })
})

describe("add model", () => {
  it("mints an id and appends a model route, requiring only --provider and --model", async () => {
    const seeded = {
      ...defaultConfig(),
      providers: [
        {
          id: "p_openai" as never,
          name: "OpenAI",
          sdkProvider: "openai" as const,
          config: {},
          secrets: {},
          models: ["gpt-4o"],
        },
      ],
    }
    const deps = makeFakeDeps({ initialConfig: seeded })
    const result = await runCli(deps)([
      "add",
      "model",
      "--provider",
      "p_openai",
      "--model",
      "gpt-4o",
    ])
    expect(result).toEqual({ ok: true, value: undefined })

    const loaded = await deps.config.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.models).toHaveLength(1)
    const added = loaded.value.models[0]
    expect(added?.id).toMatch(/^mdl_/)
    expect(added?.providerId).toBe("p_openai" as ProviderId)
    expect(added?.providerModel).toBe("gpt-4o")
  })

  it("returns a usage error when a required model flag is missing", async () => {
    const result = await runCli(makeFakeDeps())([
      "add",
      "model",
      "--provider",
      "p_openai",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("returns a usage error when the add subcommand is unknown", async () => {
    const result = await runCli(makeFakeDeps())(["add", "widget", "--id", "x"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("add model parses comma-separated --aliases into the route", async () => {
    const seeded = {
      ...defaultConfig(),
      providers: [
        {
          id: "p1" as never,
          name: "P1",
          sdkProvider: "anthropic" as const,
          config: {},
          secrets: {},
          models: ["claude-haiku-4-5"],
        },
      ],
    }
    const deps = makeFakeDeps({ initialConfig: seeded })
    const r = await runCli(deps)([
      "add",
      "model",
      "--provider",
      "p1",
      "--model",
      "claude-haiku-4-5",
      "--aliases",
      "haiku,small",
    ])
    expect(r.ok).toBe(true)
    const loaded = await deps.config.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.models.at(-1)?.aliases).toEqual(["haiku", "small"])
  })
})
