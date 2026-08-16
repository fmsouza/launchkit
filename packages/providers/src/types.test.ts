import { describe, expect, it } from "bun:test"
import { ConfigFieldSpecSchema, ProviderCatalogEntrySchema } from "./types"

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
