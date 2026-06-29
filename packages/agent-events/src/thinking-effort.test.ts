import { describe, expect, it } from "bun:test"
import { THINKING_EFFORTS, ThinkingEffortSchema } from "./thinking-effort"

describe("ThinkingEffort", () => {
  it("lists the six tiers in ascending order", () => {
    expect(THINKING_EFFORTS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ])
  })
  it("accepts a valid tier", () => {
    expect(ThinkingEffortSchema.parse("high")).toBe("high")
  })
  it("rejects an unknown tier", () => {
    expect(ThinkingEffortSchema.safeParse("ultra").success).toBe(false)
  })
})
