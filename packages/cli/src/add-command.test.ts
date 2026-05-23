import { describe, expect, it } from "bun:test"
import { defaultConfig } from "@launchkit/config"
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

describe("add alias", () => {
  it("appends an alias mapping and saves the config", async () => {
    const seeded = {
      ...defaultConfig(),
      providers: [
        {
          id: "p_openai" as never,
          name: "OpenAI",
          sdkProvider: "openai" as const,
          config: {},
          secrets: {},
          models: ["gpt-4o-mini"],
        },
      ],
    }
    const deps = makeFakeDeps({ initialConfig: seeded })
    const result = await runCli(deps)([
      "add",
      "alias",
      "--name",
      "fast",
      "--provider",
      "p_openai",
      "--model",
      "gpt-4o-mini",
    ])
    expect(result).toEqual({ ok: true, value: undefined })

    const loaded = await deps.config.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const added = loaded.value.aliases.find((a) => a.alias === "fast")
    expect(added?.providerId).toBe("p_openai")
    expect(added?.providerModel).toBe("gpt-4o-mini")
  })

  it("returns a usage error when a required alias flag is missing", async () => {
    const result = await runCli(makeFakeDeps())([
      "add",
      "alias",
      "--name",
      "fast",
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
})
