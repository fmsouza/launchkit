import { describe, it, expect } from "bun:test"
import { ProviderSchema } from "./provider"

const valid = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secrets: { apiKey: { ref: "kc_openai" } },
  models: ["gpt-4o", "gpt-4o-mini"],
}

describe("ProviderSchema", () => {
  it("parses a valid provider with secret references", () => {
    expect(ProviderSchema.parse(valid)).toEqual(valid)
  })
  it("rejects a provider whose secrets contain a raw value", () => {
    expect(ProviderSchema.safeParse({ ...valid, secrets: { apiKey: { ref: "k", value: "sk" } } }).success).toBe(false)
  })
  it("rejects an unknown sdkProvider", () => {
    expect(ProviderSchema.safeParse({ ...valid, sdkProvider: "nope" }).success).toBe(false)
  })
  it("rejects unknown top-level fields", () => {
    expect(ProviderSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })
})
