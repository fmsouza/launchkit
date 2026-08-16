import { describe, expect, it } from "bun:test"
import { getDescriptor } from "@spectrum/providers"
import type { ProviderDescriptor } from "@spectrum/providers"
import { loadSdk } from "./load-sdk"

const pluginDescriptor = (
  wire: "openai" | "anthropic",
): ProviderDescriptor => ({
  key: "plugin:acme",
  label: "Acme",
  configFields: [],
  secretFields: [],
  supportsCustomHeaders: false,
  streaming: "incremental",
  configSchema: getDescriptor("custom").configSchema,
  sdkMapping: {
    baseUrlOption: "baseURL",
    apiKey: { kind: "option", name: "apiKey" },
    wire,
  },
  discovery: { strategy: "none" },
  reasoning: { shape: "none", supportedTiers: [] },
})

describe("loadSdk", () => {
  it("loads an SDK module for custom (OpenAI-compatible)", async () => {
    const mod = await loadSdk(getDescriptor("custom"))
    expect(typeof mod.create).toBe("function")
  })

  it("loads an SDK module for openrouter (OpenAI-compatible)", async () => {
    const mod = await loadSdk(getDescriptor("openrouter"))
    expect(typeof mod.create).toBe("function")
  })

  it("loads an SDK module for ollama (cloud)", async () => {
    const mod = await loadSdk(getDescriptor("ollama"))
    expect(typeof mod.create).toBe("function")
  })

  it("returns a create function when given a builtin descriptor", async () => {
    const mod = await loadSdk(getDescriptor("openai"))
    expect(typeof mod.create).toBe("function")
  })

  it("returns the openai factory when a plugin descriptor declares the openai wire", async () => {
    const mod = await loadSdk(pluginDescriptor("openai"))
    expect(mod.create).toBe((await import("@ai-sdk/openai")).createOpenAI)
  })

  it("returns the anthropic factory when a plugin descriptor declares the anthropic wire", async () => {
    const mod = await loadSdk(pluginDescriptor("anthropic"))
    expect(mod.create).toBe((await import("@ai-sdk/anthropic")).createAnthropic)
  })

  it("throws when a plugin descriptor declares no wire", async () => {
    const broken = pluginDescriptor("openai")
    const noWire: ProviderDescriptor = {
      ...broken,
      sdkMapping: { baseUrlOption: "baseURL", apiKey: { kind: "none" } },
    }
    await expect(loadSdk(noWire)).rejects.toThrow()
  })
})
