import { describe, expect, it } from "bun:test"
import { defaultConfig } from "@launchkit/config"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"

const seeded = () => ({
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
  aliases: [
    {
      alias: "fast" as never,
      providerId: "p_openai" as never,
      providerModel: "gpt-4o-mini",
    },
  ],
})

describe("remove provider", () => {
  it("drops the matching provider and saves the config", async () => {
    const deps = makeFakeDeps({ initialConfig: seeded() })
    const result = await runCli(deps)(["remove", "provider", "p_openai"])
    expect(result).toEqual({ ok: true, value: undefined })
    const loaded = await deps.config.load()
    expect(loaded.ok && loaded.value.providers).toEqual([])
  })

  it("returns a failed error when the provider id does not exist", async () => {
    const result = await runCli(makeFakeDeps({ initialConfig: seeded() }))([
      "remove",
      "provider",
      "ghost",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })

  it("returns a usage error when no provider id is given", async () => {
    const result = await runCli(makeFakeDeps({ initialConfig: seeded() }))([
      "remove",
      "provider",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })
})

describe("remove alias", () => {
  it("drops the matching alias and saves the config", async () => {
    const deps = makeFakeDeps({ initialConfig: seeded() })
    const result = await runCli(deps)(["remove", "alias", "fast"])
    expect(result).toEqual({ ok: true, value: undefined })
    const loaded = await deps.config.load()
    expect(loaded.ok && loaded.value.aliases).toEqual([])
  })

  it("returns a failed error when the alias name does not exist", async () => {
    const result = await runCli(makeFakeDeps({ initialConfig: seeded() }))([
      "remove",
      "alias",
      "nope",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })

  it("returns a usage error when the remove subcommand is unknown", async () => {
    const result = await runCli(makeFakeDeps({ initialConfig: seeded() }))([
      "remove",
      "widget",
      "x",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })
})
