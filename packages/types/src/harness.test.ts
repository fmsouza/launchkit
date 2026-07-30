import { describe, expect, it } from "bun:test"
import { HarnessDefinitionSchema } from "./harness"

const claude = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  builtIn: true,
}

describe("HarnessDefinitionSchema", () => {
  it("parses a valid built-in harness", () => {
    const parsed = HarnessDefinitionSchema.parse(claude)
    expect(parsed.id).toBe<string>("claude")
    expect(parsed.name).toBe("Claude Code")
    expect(parsed.command).toBe("claude")
    expect(parsed.apiFormat).toBe("anthropic")
    expect(parsed.builtIn).toBe(true)
  })
  it("parses a harness with an optional description omitted", () => {
    expect(HarnessDefinitionSchema.safeParse(claude).success).toBe(true)
  })
  it("rejects a harness with an invalid apiFormat", () => {
    expect(
      HarnessDefinitionSchema.safeParse({ ...claude, apiFormat: "soap" })
        .success,
    ).toBe(false)
  })

  it("parses a harness with an acp config", () => {
    const parsed = HarnessDefinitionSchema.parse({
      ...claude,
      acp: { args: ["--acp"], native: false },
    })
    expect(parsed.acp).toEqual({ args: ["--acp"], native: false })
  })

  it("parses a harness with an acp config that is native", () => {
    const parsed = HarnessDefinitionSchema.parse({
      ...claude,
      acp: { args: ["acp"], native: true },
    })
    expect(parsed.acp?.native).toBe(true)
  })

  it("rejects an acp config missing args", () => {
    expect(
      HarnessDefinitionSchema.safeParse({ ...claude, acp: { native: true } })
        .success,
    ).toBe(false)
  })

  it("rejects an acp config missing native", () => {
    expect(
      HarnessDefinitionSchema.safeParse({ ...claude, acp: { args: ["acp"] } })
        .success,
    ).toBe(false)
  })

  it("accepts a harness with no acp config (optional)", () => {
    expect(HarnessDefinitionSchema.safeParse(claude).success).toBe(true)
  })

  it("parses an acp config with a command override", () => {
    const parsed = HarnessDefinitionSchema.parse({
      ...claude,
      acp: { command: "claude-code-acp", args: [], native: false },
    })
    expect(parsed.acp?.command).toBe("claude-code-acp")
  })

  it("accepts an empty args array when the acp config overrides the command", () => {
    expect(
      HarnessDefinitionSchema.safeParse({
        ...claude,
        acp: { command: "claude-code-acp", args: [], native: false },
      }).success,
    ).toBe(true)
  })

  it("rejects an acp config with a blank command override", () => {
    expect(
      HarnessDefinitionSchema.safeParse({
        ...claude,
        acp: { command: "", args: [], native: false },
      }).success,
    ).toBe(false)
  })
})
