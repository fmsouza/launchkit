import { describe, expect, it } from "bun:test"
import { descriptorFromContribution } from "./descriptor"
import { ProviderContributionSchema } from "./provider-contribution"

/** Overrides for the identity-bearing fields of a contribution fixture. */
type FixtureOverrides = {
  id?: string
  label?: string
  wire?: "openai" | "anthropic"
  configFields?: readonly {
    name: string
    label: string
    kind: "url" | "text" | "headers"
    required: boolean
  }[]
}

/** A complete, well-formed contribution, parsed the same way a real manifest would be. */
const parse = (overrides: FixtureOverrides = {}) =>
  ProviderContributionSchema.parse({
    id: overrides.id ?? "acme",
    descriptor: {
      label: overrides.label ?? "Acme",
      configFields: overrides.configFields ?? [
        {
          name: "serverUrl",
          label: "Server URL",
          kind: "url",
          required: true,
        },
      ],
      secretFields: [{ name: "apiKey", label: "API key", required: true }],
      supportsCustomHeaders: false,
      streaming: "buffered",
      reasoning: {
        shape: "openai-effort",
        supportedTiers: ["off", "low", "high"],
      },
      discovery: { strategy: "openai-models" },
      actions: [
        { kind: "flow", id: "signin", label: "Sign in", context: "create" },
      ],
    },
    transport: {
      kind: "http",
      wire: overrides.wire ?? "anthropic",
      launch: {
        command: "acme-server",
        args: ["--port", "{{port}}"],
        envTemplate: { API_KEY: "{{apiKey}}" },
      },
    },
  })

/** A second contribution, materially different from `parse()`'s defaults, to prove the
 * projection actually reads its argument instead of returning a value fixed to one fixture. */
const parseOther = () =>
  parse({
    id: "othername",
    label: "Othername",
    wire: "openai",
    configFields: [
      { name: "apiBase", label: "API base", kind: "url", required: true },
    ],
  })

describe("descriptorFromContribution", () => {
  it("derives a plugin-prefixed key from the contribution id", () => {
    expect(descriptorFromContribution(parse()).key).toBe("plugin:acme")
    expect(descriptorFromContribution(parseOther()).key).toBe(
      "plugin:othername",
    )
  })

  it("carries label, streaming profile, discovery, and actions through", () => {
    const descriptor = descriptorFromContribution(parse())
    expect(descriptor.label).toBe("Acme")
    expect(descriptor.streaming).toBe("buffered")
    expect(descriptor.discovery).toEqual({ strategy: "openai-models" })
    expect(descriptor.actions).toEqual([
      { kind: "flow", id: "signin", label: "Sign in", context: "create" },
    ])

    const other = descriptorFromContribution(parseOther())
    expect(other.label).toBe("Othername")
  })

  it("sets the sdk wire from the contribution transport", () => {
    expect(descriptorFromContribution(parse()).sdkMapping.wire).toBe(
      "anthropic",
    )
    expect(descriptorFromContribution(parseOther()).sdkMapping.wire).toBe(
      "openai",
    )
  })

  it("derives a config schema accepting a declared field", () => {
    const descriptor = descriptorFromContribution(parse())
    const result = descriptor.configSchema.safeParse({
      serverUrl: "https://example.com",
    })
    expect(result.success).toBe(true)

    // A contribution with a different field name derives a schema shaped around
    // *that* name — not a schema fixed to "serverUrl".
    const other = descriptorFromContribution(parseOther())
    const otherResult = other.configSchema.safeParse({
      apiBase: "https://example.com",
    })
    expect(otherResult.success).toBe(true)
  })

  it("derives a config schema rejecting an undeclared field", () => {
    const descriptor = descriptorFromContribution(parse())
    const result = descriptor.configSchema.safeParse({
      serverUrl: "https://example.com",
      extraField: "not declared",
    })
    expect(result.success).toBe(false)

    // "serverUrl" is declared for parse() but not for parseOther() — the derived
    // schema for the second contribution must reject it as unknown.
    const other = descriptorFromContribution(parseOther())
    const otherResult = other.configSchema.safeParse({
      apiBase: "https://example.com",
      serverUrl: "https://example.com",
    })
    expect(otherResult.success).toBe(false)
  })

  it("declares a placeholder api key so a keyless local server still builds", () => {
    expect(
      descriptorFromContribution(parse()).sdkMapping.placeholderApiKey,
    ).toBeDefined()
  })
})
