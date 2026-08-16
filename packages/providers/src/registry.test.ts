import { describe, expect, it } from "bun:test"
import { getDescriptor, listDescriptors, providerCatalog } from "./catalog"
import { createProviderRegistry } from "./registry"
import type { ProviderDescriptor } from "./types"

const plugin = (key: string): ProviderDescriptor => ({
  ...getDescriptor("custom"),
  key,
  label: "Acme",
})

describe("createProviderRegistry", () => {
  it("resolves a builtin descriptor when given a builtin key", () => {
    const registry = createProviderRegistry()
    expect(registry.get("anthropic")?.label).toBe("Anthropic")
  })

  it("returns undefined when the key is unknown", () => {
    const registry = createProviderRegistry()
    expect(registry.get("plugin:nope")).toBeUndefined()
  })

  it("resolves a plugin descriptor when the plugin is registered", () => {
    const registry = createProviderRegistry([plugin("plugin:acme")])
    expect(registry.get("plugin:acme")?.label).toBe("Acme")
  })

  it("includes plugin entries in the catalog when plugins are registered", () => {
    const registry = createProviderRegistry([plugin("plugin:acme")])
    expect(registry.catalog().map((e) => e.key)).toContain("plugin:acme")
  })

  it("ignores a plugin descriptor when its key is not plugin-prefixed", () => {
    const registry = createProviderRegistry([plugin("anthropic")])
    expect(registry.get("anthropic")?.label).toBe("Anthropic")
  })

  it("keeps the first entry when two plugins claim the same key", () => {
    const first = { ...plugin("plugin:dup"), label: "First" }
    const second = { ...plugin("plugin:dup"), label: "Second" }
    const registry = createProviderRegistry([first, second])
    expect(registry.get("plugin:dup")?.label).toBe("First")
  })

  it("is identical to the old static catalog when no plugins are registered", () => {
    const registry = createProviderRegistry()
    expect(registry.list()).toEqual(listDescriptors())
    expect(registry.catalog()).toEqual(providerCatalog())
  })
})
