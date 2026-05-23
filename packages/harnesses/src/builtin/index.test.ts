import { describe, expect, it } from "bun:test"
import { HarnessDefinitionSchema, HarnessIdSchema } from "@launchkit/types"
import { ALLOWED_TOKENS } from "../tokens"
import { builtinHarnesses, claude, codex, openclaw, opencode } from "./index"

const tokensIn = (s: string): readonly string[] =>
  [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "")

describe("builtinHarnesses", () => {
  it("lists all four built-ins in a stable order when imported", () => {
    expect(builtinHarnesses.map((h) => h.id)).toEqual([
      HarnessIdSchema.parse("claude"),
      HarnessIdSchema.parse("codex"),
      HarnessIdSchema.parse("opencode"),
      HarnessIdSchema.parse("openclaw"),
    ])
  })

  it("marks every built-in as builtIn:true", () => {
    expect(builtinHarnesses.every((h) => h.builtIn === true)).toBe(true)
  })

  it("parses every built-in through HarnessDefinitionSchema", () => {
    for (const h of builtinHarnesses) {
      expect(HarnessDefinitionSchema.safeParse(h).success).toBe(true)
    }
  })

  it("uses only the allowed tokens in every env template value", () => {
    for (const h of builtinHarnesses) {
      for (const value of Object.values(h.envTemplate)) {
        for (const token of tokensIn(value)) {
          expect(ALLOWED_TOKENS).toContain(
            token as (typeof ALLOWED_TOKENS)[number],
          )
        }
      }
    }
  })

  it("wires claude to the Anthropic env vars with proxy tokens", () => {
    expect(claude.apiFormat).toBe("anthropic")
    expect(claude.command).toBe("claude")
    expect(claude.envTemplate).toEqual({
      ANTHROPIC_BASE_URL: "{{proxyUrl}}",
      ANTHROPIC_API_KEY: "{{proxyKey}}",
      ANTHROPIC_MODEL: "{{model}}",
    })
  })

  it("wires codex and opencode to the OpenAI env vars", () => {
    expect(codex.apiFormat).toBe("openai")
    expect(opencode.apiFormat).toBe("openai")
    expect(codex.envTemplate).toEqual(opencode.envTemplate)
    expect(codex.envTemplate).toEqual({
      OPENAI_BASE_URL: "{{proxyUrl}}",
      OPENAI_API_KEY: "{{proxyKey}}",
      OPENAI_MODEL: "{{model}}",
    })
  })

  it("wires openclaw to the Anthropic env vars", () => {
    expect(openclaw.apiFormat).toBe("anthropic")
    expect(openclaw.envTemplate).toEqual(claude.envTemplate)
  })
})
