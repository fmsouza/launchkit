import { describe, expect, it } from "bun:test"
import {
  ConfigFieldSpecSchema,
  DiscoverySchema,
  ProviderCatalogEntrySchema,
} from "./types"

describe("ConfigFieldSpecSchema", () => {
  it("accepts a minimal url field when only required keys are present", () => {
    const r = ConfigFieldSpecSchema.safeParse({
      name: "serverUrl",
      label: "Server URL",
      kind: "url",
      required: false,
    })
    expect(r.success).toBe(true)
  })

  it("rejects an unknown field kind", () => {
    const r = ConfigFieldSpecSchema.safeParse({
      name: "x",
      label: "X",
      kind: "number",
      required: false,
    })
    expect(r.success).toBe(false)
  })
})

describe("ProviderCatalogEntrySchema", () => {
  it("accepts a presentational entry with field specs", () => {
    const r = ProviderCatalogEntrySchema.safeParse({
      key: "openai",
      label: "OpenAI",
      configFields: [],
      secretFields: [{ name: "apiKey", label: "API key", required: true }],
      supportsCustomHeaders: false,
      actions: [
        { kind: "edit-config", id: "edit", label: "Edit provider" },
        { kind: "set-secrets", id: "secrets", label: "Set secret" },
      ],
    })
    expect(r.success).toBe(true)
  })
})

describe("DiscoverySchema", () => {
  it("accepts an openai-models strategy with no default base URL", () => {
    const r = DiscoverySchema.safeParse({ strategy: "openai-models" })
    expect(r.success).toBe(true)
  })

  it("accepts an ollama-tags strategy with sendAuthHeader set", () => {
    const r = DiscoverySchema.safeParse({
      strategy: "ollama-tags",
      sendAuthHeader: true,
      defaultBaseUrl: "http://localhost:11434",
    })
    expect(r.success).toBe(true)
  })

  it("accepts a none strategy", () => {
    const r = DiscoverySchema.safeParse({ strategy: "none" })
    expect(r.success).toBe(true)
  })

  it("rejects an ollama-tags strategy missing sendAuthHeader", () => {
    const r = DiscoverySchema.safeParse({ strategy: "ollama-tags" })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown strategy", () => {
    const r = DiscoverySchema.safeParse({ strategy: "made-up" })
    expect(r.success).toBe(false)
  })
})
