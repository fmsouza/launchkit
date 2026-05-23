import { describe, it, expect } from "bun:test"
import { renderTemplate } from "./template"

describe("renderTemplate", () => {
  it("replaces every {{token}} with the matching variable when all are provided", () => {
    const r = renderTemplate("{{proxyUrl}}/v1 key={{proxyKey}}", { proxyUrl: "http://localhost:4000", proxyKey: "abc" })
    expect(r).toEqual({ ok: true, value: "http://localhost:4000/v1 key=abc" })
  })
  it("returns an unknown-token error when a placeholder has no variable", () => {
    const r = renderTemplate("hi {{missing}}", { name: "x" })
    expect(r).toEqual({ ok: false, error: { kind: "unknown-token", token: "missing" } })
  })
  it("leaves text without placeholders unchanged", () => {
    expect(renderTemplate("plain", {})).toEqual({ ok: true, value: "plain" })
  })
})
