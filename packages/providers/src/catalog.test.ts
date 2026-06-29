import { describe, expect, it } from "bun:test"
import { SdkProviderSchema } from "@spectrum/types"
import { getDescriptor, listDescriptors, providerCatalog } from "./catalog"

describe("provider catalog", () => {
  it("has exactly one descriptor for every SdkProvider value", () => {
    const keys = listDescriptors()
      .map((d) => d.key)
      .sort()
    const expected = [...SdkProviderSchema.options].sort()
    expect(keys).toEqual(expected)
  })

  it("returns the custom descriptor as an OpenAI-compatible provider with optional url + headers", () => {
    const d = getDescriptor("custom")
    expect(d.supportsCustomHeaders).toBe(true)
    expect(d.discovery.strategy).toBe("openai-models")
    expect(d.configFields.some((f) => f.name === "serverUrl")).toBe(true)
    expect(d.configFields.some((f) => f.kind === "headers")).toBe(true)
    expect(d.secretFields.find((s) => s.name === "apiKey")?.required).toBe(
      false,
    )
    expect(d.sdkMapping.placeholderApiKey).toBe("not-needed")
  })

  it("maps the ollama cloud api key to an Authorization Bearer header", () => {
    const d = getDescriptor("ollama")
    expect(d.sdkMapping.apiKey).toEqual({
      kind: "header",
      name: "Authorization",
      scheme: "Bearer",
    })
    expect(d.sdkMapping.defaultBaseUrl).toBe("https://ollama.com/api")
    expect(d.secretFields.find((s) => s.name === "apiKey")?.required).toBe(true)
    expect(d.discovery).toEqual({
      strategy: "ollama-tags",
      sendAuthHeader: true,
      defaultBaseUrl: "https://ollama.com/api",
    })
  })

  it("configures openrouter with a fixed base url and attribution header fields", () => {
    const d = getDescriptor("openrouter")
    expect(d.sdkMapping.defaultBaseUrl).toBe("https://openrouter.ai/api/v1")
    expect(d.sdkMapping.apiKey).toEqual({ kind: "option", name: "apiKey" })
    const referer = d.configFields.find((f) => f.name === "httpReferer")
    expect(referer?.mapsToHeader).toBe("HTTP-Referer")
    const title = d.configFields.find((f) => f.name === "appTitle")
    expect(title?.mapsToHeader).toBe("X-Title")
  })

  it("projects a presentational entry without the zod schema or sdk mapping", () => {
    const entry = providerCatalog().find((e) => e.key === "custom")
    expect(entry).toBeDefined()
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        "configFields",
        "key",
        "label",
        "secretFields",
        "supportsCustomHeaders",
      ].sort(),
    )
  })

  it("marks ollama as a buffered-streaming provider and openai as incremental", () => {
    expect(getDescriptor("ollama").streaming).toBe("buffered")
    expect(getDescriptor("openai").streaming).toBe("incremental")
  })

  it("assigns a reasoning shape to every descriptor", () => {
    for (const d of listDescriptors()) {
      expect(typeof d.reasoning.shape).toBe("string")
      expect(Array.isArray(d.reasoning.supportedTiers)).toBe(true)
    }
  })

  it("uses anthropic-thinking for anthropic and openai-effort for openai", () => {
    expect(getDescriptor("anthropic").reasoning.shape).toBe(
      "anthropic-thinking",
    )
    expect(getDescriptor("openai").reasoning.shape).toBe("openai-effort")
    expect(getDescriptor("google").reasoning.shape).toBe("google-thinking")
  })
})
