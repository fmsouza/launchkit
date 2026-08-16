import { describe, expect, it } from "bun:test"
import { descriptorFromContribution } from "./descriptor"
import { ProviderContributionSchema } from "./provider-contribution"

/** A complete, well-formed contribution, parsed the same way a real manifest would be. */
const parse = () =>
  ProviderContributionSchema.parse({
    id: "acme",
    descriptor: {
      label: "Acme",
      configFields: [
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
      wire: "anthropic",
      launch: {
        command: "acme-server",
        args: ["--port", "{{port}}"],
        envTemplate: { API_KEY: "{{apiKey}}" },
      },
    },
  })

describe("descriptorFromContribution", () => {
  it("derives a plugin-prefixed key from the contribution id", () => {
    expect(descriptorFromContribution(parse()).key).toBe("plugin:acme")
  })

  it("carries label, streaming profile, discovery, and actions through", () => {
    const descriptor = descriptorFromContribution(parse())
    expect(descriptor.label).toBe("Acme")
    expect(descriptor.streaming).toBe("buffered")
    expect(descriptor.discovery).toEqual({ strategy: "openai-models" })
    expect(descriptor.actions).toEqual([
      { kind: "flow", id: "signin", label: "Sign in", context: "create" },
    ])
  })

  it("sets the sdk wire from the contribution transport", () => {
    expect(descriptorFromContribution(parse()).sdkMapping.wire).toBe(
      "anthropic",
    )
  })

  it("derives a config schema accepting a declared field", () => {
    const descriptor = descriptorFromContribution(parse())
    const result = descriptor.configSchema.safeParse({
      serverUrl: "https://example.com",
    })
    expect(result.success).toBe(true)
  })

  it("derives a config schema rejecting an undeclared field", () => {
    const descriptor = descriptorFromContribution(parse())
    const result = descriptor.configSchema.safeParse({
      serverUrl: "https://example.com",
      extraField: "not declared",
    })
    expect(result.success).toBe(false)
  })

  it("declares a placeholder api key so a keyless local server still builds", () => {
    expect(
      descriptorFromContribution(parse()).sdkMapping.placeholderApiKey,
    ).toBeDefined()
  })
})
