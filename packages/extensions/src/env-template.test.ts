import { describe, expect, it } from "bun:test"
import type { PluginId } from "@spectrum/types"
import {
  allowedTokensFor,
  renderPluginArgs,
  renderPluginEnv,
  validateContributionTemplates,
} from "./env-template"
import {
  PluginLaunchSchema,
  type ProviderContribution,
} from "./provider-contribution"

/** Builds a minimal, well-formed ProviderContribution with a launch block for env-template tests. */
const contribution = (
  envTemplate: Readonly<Record<string, string>>,
  args: readonly string[] = [],
): ProviderContribution => ({
  id: "acme" as PluginId,
  descriptor: {
    label: "Acme",
    configFields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: false,
      },
    ],
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    supportsCustomHeaders: false,
    streaming: "incremental",
    reasoning: { shape: "none", supportedTiers: [] },
    discovery: { strategy: "none" },
    actions: [
      { kind: "edit-config", id: "edit", label: "Edit", context: "both" },
    ],
  },
  transport: {
    kind: "http",
    wire: "openai",
    launch: {
      command: "acme",
      args: [...args],
      envTemplate: { ...envTemplate },
      healthPath: "/models",
      readyTimeoutMs: 10_000,
    },
  },
})

describe("allowedTokensFor", () => {
  it("includes runtime tokens plus declared secret and config field names", () => {
    expect([...allowedTokensFor(contribution({}))].sort()).toEqual(
      ["apiKey", "baseUrl", "host", "hostToken", "port", "serverUrl"].sort(),
    )
  })
})

describe("validateContributionTemplates", () => {
  it("accepts a template using a declared secret token", () => {
    expect(
      validateContributionTemplates(contribution({ K: "{{apiKey}}" })).ok,
    ).toBe(true)
  })

  it("accepts a template using the host token", () => {
    expect(
      validateContributionTemplates(contribution({ T: "{{hostToken}}" })).ok,
    ).toBe(true)
  })

  it("rejects a template using a token the contribution never declared", () => {
    const result = validateContributionTemplates(
      contribution({ K: "{{proxyKey}}" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-manifest")
  })

  it("rejects an unknown token appearing in args rather than env", () => {
    const result = validateContributionTemplates(
      contribution({}, ["--x", "{{nope}}"]),
    )
    expect(result.ok).toBe(false)
  })
})

describe("renderPluginEnv / renderPluginArgs", () => {
  it("substitutes every token when a value is supplied", () => {
    const launch = PluginLaunchSchema.parse({
      command: "acme",
      args: ["--port", "{{port}}"],
      envTemplate: {
        ACME_KEY: "{{apiKey}}",
        URL: "{{baseUrl}}",
        TOK: "{{hostToken}}",
      },
    })
    const values = {
      port: "9000",
      apiKey: "sk-x",
      baseUrl: "http://127.0.0.1:9000",
      hostToken: "tok-1",
    }
    expect(renderPluginEnv(launch, values)).toEqual({
      ACME_KEY: "sk-x",
      URL: "http://127.0.0.1:9000",
      TOK: "tok-1",
    })
    expect(renderPluginArgs(launch, values)).toEqual(["--port", "9000"])
  })

  it("renders an empty string when a token has no supplied value", () => {
    const launch = PluginLaunchSchema.parse({
      command: "acme",
      args: [],
      envTemplate: { ACME_KEY: "{{apiKey}}" },
    })
    expect(renderPluginEnv(launch, {})).toEqual({ ACME_KEY: "" })
  })
})
