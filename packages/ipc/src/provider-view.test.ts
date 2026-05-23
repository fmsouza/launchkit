import { describe, it, expect } from "bun:test"
import { ProviderViewSchema } from "./provider-view"

const view = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o", "gpt-4o-mini"],
}

describe("ProviderViewSchema", () => {
  it("parses a valid provider view with presence-only secret fields", () => {
    expect(ProviderViewSchema.parse(view)).toEqual(view)
  })
  it("rejects a secret field that carries a ref", () => {
    expect(ProviderViewSchema.safeParse({ ...view, secretFields: { apiKey: { isSet: true, ref: "kc_x" } } }).success).toBe(false)
  })
  it("rejects a secret field that carries a raw value", () => {
    expect(ProviderViewSchema.safeParse({ ...view, secretFields: { apiKey: { isSet: true, value: "sk-xxx" } } }).success).toBe(false)
  })
  it("rejects an unknown sdkProvider", () => {
    expect(ProviderViewSchema.safeParse({ ...view, sdkProvider: "nope" }).success).toBe(false)
  })
  it("rejects unknown top-level fields", () => {
    expect(ProviderViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false)
  })
})
