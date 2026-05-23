import { describe, it, expect } from "bun:test"
import { HarnessDefinitionSchema } from "./harness"

const claude = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: { ANTHROPIC_BASE_URL: "{{proxyUrl}}", ANTHROPIC_API_KEY: "{{proxyKey}}", ANTHROPIC_MODEL: "{{model}}" },
  defaultAlias: "default",
  builtIn: true,
}

describe("HarnessDefinitionSchema", () => {
  it("parses a valid built-in harness", () => {
    expect(HarnessDefinitionSchema.parse(claude)).toEqual(claude)
  })
  it("parses a harness with an optional description omitted", () => {
    expect(HarnessDefinitionSchema.safeParse(claude).success).toBe(true)
  })
  it("rejects a harness with an invalid apiFormat", () => {
    expect(HarnessDefinitionSchema.safeParse({ ...claude, apiFormat: "soap" }).success).toBe(false)
  })
})
