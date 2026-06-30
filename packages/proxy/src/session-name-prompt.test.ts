import { describe, expect, it } from "bun:test"
import { NAME_PROMPT_MAX, buildNamePrompt } from "./session-name-prompt"

describe("buildNamePrompt", () => {
  it("returns a system instruction asking for a short concise title", () => {
    const { system, user } = buildNamePrompt("Help me debug a flaky test")
    expect(system).toMatch(/short.*title/i)
    expect(system).toMatch(/≤ 6 words|6 words/i)
    expect(user).toBe("Help me debug a flaky test")
  })

  it("truncates the user prompt to NAME_PROMPT_MAX chars", () => {
    const long = "x".repeat(NAME_PROMPT_MAX + 50)
    const { user } = buildNamePrompt(long)
    expect(user.length).toBe(NAME_PROMPT_MAX)
  })

  it("keeps a short prompt unchanged", () => {
    const { user } = buildNamePrompt("hi")
    expect(user).toBe("hi")
  })

  it("exposes NAME_PROMPT_MAX = 4000", () => {
    expect(NAME_PROMPT_MAX).toBe(4000)
  })
})
