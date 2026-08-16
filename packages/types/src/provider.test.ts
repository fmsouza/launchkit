import { describe, expect, it } from "bun:test"
import { ProviderKeySchema, isPluginKey, pluginIdOf } from "./index"
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
    const parsed = ProviderSchema.parse(valid)
    expect(parsed.id).toBe<string>("p_openai")
    expect(parsed.name).toBe("OpenAI")
    expect(parsed.sdkProvider).toBe("openai")
    expect(parsed.models).toEqual(["gpt-4o", "gpt-4o-mini"])
  })
  it("rejects a provider whose secrets contain a raw value", () => {
    expect(
      ProviderSchema.safeParse({
        ...valid,
        secrets: { apiKey: { ref: "k", value: "sk" } },
      }).success,
    ).toBe(false)
  })
  it("rejects an unknown sdkProvider", () => {
    expect(
      ProviderSchema.safeParse({ ...valid, sdkProvider: "nope" }).success,
    ).toBe(false)
  })
  it("rejects unknown top-level fields", () => {
    expect(ProviderSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })
})

describe("ProviderKeySchema", () => {
  it("accepts a builtin key when the key is an SdkProvider member", () => {
    expect(ProviderKeySchema.safeParse("anthropic").success).toBe(true)
  })

  it("accepts a plugin key when it is prefixed and slug-shaped", () => {
    expect(ProviderKeySchema.safeParse("plugin:my-provider").success).toBe(true)
  })

  it("rejects a plugin key when the id has uppercase characters", () => {
    expect(ProviderKeySchema.safeParse("plugin:MyProvider").success).toBe(false)
  })

  it("rejects a bare unknown key when it carries no plugin prefix", () => {
    expect(ProviderKeySchema.safeParse("my-provider").success).toBe(false)
  })
})

describe("isPluginKey / pluginIdOf", () => {
  it("reports true and extracts the id when the key is a plugin key", () => {
    expect(isPluginKey("plugin:acme")).toBe(true)
    expect(pluginIdOf("plugin:acme")).toBe("acme")
  })

  it("reports false and extracts nothing when the key is a builtin", () => {
    expect(isPluginKey("openai")).toBe(false)
    expect(pluginIdOf("openai")).toBeUndefined()
  })
})

describe("ProviderSchema with plugin keys", () => {
  it("accepts a provider record when sdkProvider is a plugin key", () => {
    const parsed = ProviderSchema.safeParse({
      id: "prv_1",
      name: "My Provider",
      sdkProvider: "plugin:acme",
      config: {},
      secrets: {},
      models: [],
    })
    expect(parsed.success).toBe(true)
  })
})
