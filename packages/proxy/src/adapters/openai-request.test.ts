import { describe, it, expect } from "bun:test"
import { parseOpenAIRequest } from "./openai-request"

describe("parseOpenAIRequest", () => {
  it("maps an OpenAI chat-completions body to a normalized request, lifting the system message", () => {
    const body = { model: "fast", stream: true, messages: [
      { role: "system", content: "be terse" }, { role: "user", content: "hi" }] }
    expect(parseOpenAIRequest(body)).toEqual({ ok: true, value: {
      model: "fast", system: "be terse", stream: true,
      messages: [{ role: "user", content: "hi" }],
    } })
  })
  it("returns bad-request when messages is not an array", () => {
    expect(parseOpenAIRequest({ model: "x", messages: "nope" }).ok).toBe(false)
  })
})
