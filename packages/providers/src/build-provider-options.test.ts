import { describe, expect, it } from "bun:test"
import {
  buildProviderOptions,
  reasoningDisablesTemperature,
} from "./build-provider-options"
import type { ReasoningSupport } from "./reasoning-types"

const openai: ReasoningSupport = {
  shape: "openai-effort",
  supportedTiers: ["off", "minimal", "low", "medium", "high"],
}
const anthropic: ReasoningSupport = {
  shape: "anthropic-thinking",
  supportedTiers: ["off", "minimal", "low", "medium", "high", "max"],
}
const google: ReasoningSupport = {
  shape: "google-thinking",
  supportedTiers: ["off", "minimal", "low", "medium", "high", "max"],
}
const none: ReasoningSupport = { shape: "none", supportedTiers: [] }

describe("buildProviderOptions", () => {
  it("returns undefined for the none shape", () => {
    expect(buildProviderOptions(none, "high")).toBeUndefined()
  })

  it("returns undefined for the off tier", () => {
    expect(buildProviderOptions(openai, "off")).toBeUndefined()
  })

  it("maps openai tiers to reasoningEffort and clamps max→high", () => {
    expect(buildProviderOptions(openai, "low")).toEqual({
      openai: { reasoningEffort: "low" },
    })
    expect(buildProviderOptions(openai, "max")).toEqual({
      openai: { reasoningEffort: "high" },
    })
  })

  it("builds a google thinkingConfig budget for a tier", () => {
    const opts = buildProviderOptions(google, "high") as {
      google: { thinkingConfig: { thinkingBudget: number } }
    }
    expect(opts.google.thinkingConfig.thinkingBudget).toBeGreaterThan(0)
  })

  it("builds an anthropic thinking option for a tier", () => {
    const opts = buildProviderOptions(anthropic, "medium") as {
      anthropic: { thinking: Record<string, unknown> }
    }
    expect(opts.anthropic.thinking).toBeDefined()
  })

  it("reports that anthropic reasoning disables temperature", () => {
    expect(reasoningDisablesTemperature(anthropic)).toBe(true)
    expect(reasoningDisablesTemperature(openai)).toBe(false)
  })
})
