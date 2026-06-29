import { describe, expect, it } from "bun:test"
import { toClaudeThinkingBudget } from "./thinking-effort"

describe("toClaudeThinkingBudget", () => {
  it("disables thinking for off", () => {
    expect(toClaudeThinkingBudget("off")).toBeNull()
  })
  it("scales the budget up with the tier", () => {
    expect(toClaudeThinkingBudget("minimal")).toBe(1024)
    expect(toClaudeThinkingBudget("low")).toBe(4096)
    expect(toClaudeThinkingBudget("medium")).toBe(8192)
    expect(toClaudeThinkingBudget("high")).toBe(16384)
    expect(toClaudeThinkingBudget("max")).toBe(32768)
  })
})
