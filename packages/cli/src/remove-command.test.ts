import { describe, expect, it } from "bun:test"
import { defaultConfig } from "@spectrum/config"
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
  models: [
    {
      id: "mdl_fast" as never,
      providerId: "p_openai" as never,
      providerModel: "gpt-4o-mini",
      aliases: [],
      attachments: {},
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

describe("remove model", () => {
  it("drops the matching model by id and saves the config", async () => {
    const deps = makeFakeDeps({ initialConfig: seeded() })
    const result = await runCli(deps)(["remove", "model", "mdl_fast"])
    expect(result).toEqual({ ok: true, value: undefined })
    const loaded = await deps.config.load()
    expect(loaded.ok && loaded.value.models).toEqual([])
  })

  it("returns a failed error when the model id does not exist", async () => {
    const result = await runCli(makeFakeDeps({ initialConfig: seeded() }))([
      "remove",
      "model",
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
