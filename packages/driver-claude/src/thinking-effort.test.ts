import { describe, expect, it } from "bun:test"
import { toClaudeThinking } from "./thinking-effort"

describe("toClaudeThinking", () => {
  it("omits thinking for the off tier", () => {
    expect(toClaudeThinking("off", "claude-sonnet-4-6")).toBeNull()
  })

  it("omits thinking for a non-thinking Haiku 3.x model", () => {
    expect(toClaudeThinking("high", "claude-3-5-haiku-20241022")).toBeNull()
  })

  it("produces adaptive thinking + a mapped effort for a thinking-capable model", () => {
    expect(toClaudeThinking("medium", "claude-sonnet-4-6")).toEqual({
      thinking: { type: "adaptive" },
      effort: "medium",
    })
  })

  it("maps minimal down to the low effort level", () => {
    expect(toClaudeThinking("minimal", "claude-sonnet-4-6")).toEqual({
      thinking: { type: "adaptive" },
      effort: "low",
    })
  })

  it("omits thinking when no model is known and effort is off", () => {
    expect(toClaudeThinking("off", undefined)).toBeNull()
  })
})
