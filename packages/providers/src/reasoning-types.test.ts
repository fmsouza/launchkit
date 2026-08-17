import { describe, expect, it } from "bun:test"
import { THINKING_EFFORTS } from "@spectrum/agent-events"
import {
  ALL_TIERS,
  type ReasoningSupport,
  ReasoningSupportSchema,
} from "./reasoning-types"

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

describe("ReasoningSupportSchema", () => {
  it("accepts a well-formed reasoning support object", () => {
    const r = ReasoningSupportSchema.safeParse({
      shape: "anthropic-thinking",
      supportedTiers: ["off", "low", "high"],
    })
    expect(r.success).toBe(true)
  })

  it("rejects an unknown reasoning shape", () => {
    const r = ReasoningSupportSchema.safeParse({
      shape: "made-up-shape",
      supportedTiers: [],
    })
    expect(r.success).toBe(false)
  })

  it("rejects a supported tier outside the canonical THINKING_EFFORTS", () => {
    const r = ReasoningSupportSchema.safeParse({
      shape: "none",
      supportedTiers: ["ultra"],
    })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown extra key", () => {
    const r = ReasoningSupportSchema.safeParse({
      shape: "none",
      supportedTiers: [],
      extra: true,
    })
    expect(r.success).toBe(false)
  })
})
