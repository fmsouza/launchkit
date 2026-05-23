import { describe, expect, it } from "bun:test"
import { validateEnvTemplate } from "./validate-env-template"

describe("validateEnvTemplate", () => {
  it("returns ok when every token is one of the allowed three", () => {
    const r = validateEnvTemplate({
      ANTHROPIC_BASE_URL: "{{proxyUrl}}",
      ANTHROPIC_API_KEY: "{{proxyKey}}",
      ANTHROPIC_MODEL: "{{model}}",
    })
    expect(r).toEqual({ ok: true, value: undefined })
  })

  it("returns ok for a value with no tokens at all", () => {
    expect(validateEnvTemplate({ STATIC: "literal-value" })).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it("returns an invalid-template error naming the first unknown token", () => {
    const r = validateEnvTemplate({ X: "{{proxyUrl}}", Y: "{{secret}}" })
    expect(r).toEqual({
      ok: false,
      error: { kind: "invalid-template", token: "secret" },
    })
  })

  it("rejects an unknown token even when it appears mid-string", () => {
    expect(validateEnvTemplate({ X: "prefix-{{nope}}-suffix" })).toEqual({
      ok: false,
      error: { kind: "invalid-template", token: "nope" },
    })
  })
})
