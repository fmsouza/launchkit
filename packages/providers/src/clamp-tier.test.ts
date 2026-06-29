import { describe, expect, it } from "bun:test"
import { clampTier } from "./clamp-tier"
import type { ReasoningSupport } from "./reasoning-types"

const openai: ReasoningSupport = {
  shape: "openai-effort",
  supportedTiers: ["off", "minimal", "low", "medium", "high"],
}
const none: ReasoningSupport = { shape: "none", supportedTiers: [] }

describe("clampTier", () => {
  it("returns the tier unchanged when supported", () => {
    expect(clampTier(openai, "medium")).toBe("medium")
  })

  it("clamps a too-high tier down to the highest supported tier", () => {
    expect(clampTier(openai, "max")).toBe("high")
  })

  it("returns undefined for a none shape", () => {
    expect(clampTier(none, "high")).toBeUndefined()
  })
})
