import { describe, expect, it } from "bun:test"
import { createProviderRegistry } from "./registry"
import { validateProviderConfig } from "./validate"

describe("validateProviderConfig", () => {
  it("rejects bedrock when region is missing", () => {
    expect(
      validateProviderConfig(createProviderRegistry(), "bedrock", {}).ok,
    ).toBe(false)
  })

  it("accepts openai with an empty config", () => {
    expect(
      validateProviderConfig(createProviderRegistry(), "openai", {}).ok,
    ).toBe(true)
  })

  it("accepts custom with a server url and json headers", () => {
    const r = validateProviderConfig(createProviderRegistry(), "custom", {
      serverUrl: "http://localhost:11434/v1",
      headers: '{"X-Org":"acme"}',
    })
    expect(r.ok).toBe(true)
  })

  it("rejects custom when headers is not a json object of strings", () => {
    const r = validateProviderConfig(createProviderRegistry(), "custom", {
      headers: "not-json",
    })
    expect(r.ok).toBe(false)
  })

  it("reports an unsupported provider for an unknown key", () => {
    const r = validateProviderConfig(createProviderRegistry(), "nope", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-provider")
  })

  it("reports unsupported-provider when no descriptor claims the key", () => {
    const result = validateProviderConfig(
      createProviderRegistry(),
      "plugin:missing",
      {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("unsupported-provider")
  })
})
