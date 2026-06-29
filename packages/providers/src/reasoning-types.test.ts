import { describe, expect, it } from "bun:test"
import { THINKING_EFFORTS } from "@spectrum/agent-events"
import { ALL_TIERS, type ReasoningSupport } from "./reasoning-types"

describe("reasoning types", () => {
  it("exposes ALL_TIERS equal to the canonical THINKING_EFFORTS", () => {
    expect(ALL_TIERS).toEqual([...THINKING_EFFORTS])
  })

  it("constructs a ReasoningSupport with a shape and supported tiers", () => {
    const s: ReasoningSupport = {
      shape: "openai-effort",
      supportedTiers: ["off", "low"],
    }
    expect(s.shape).toBe("openai-effort")
    expect(s.supportedTiers).toEqual(["off", "low"])
  })
})
