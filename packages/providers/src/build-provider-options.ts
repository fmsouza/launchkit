import type { ThinkingEffort } from "@spectrum/agent-events"
import { clampTier } from "./clamp-tier"
import type { ReasoningSupport } from "./reasoning-types"

/** OpenAI reasoning effort by canonical tier (no xhigh/max → high). */
const OPENAI_EFFORT: Record<ThinkingEffort, string | undefined> = {
  off: undefined,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
}

/** Google thinkingBudget tokens by canonical tier. */
const GOOGLE_BUDGET: Record<ThinkingEffort, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  max: 24576,
}

/** Anthropic extended-thinking budget tokens by canonical tier (legacy budget path). */
const ANTHROPIC_BUDGET: Record<ThinkingEffort, number | null> = {
  off: null,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  max: 32768,
}

/** Whether enabling reasoning for this shape forbids a custom temperature (Anthropic thinking does). */
export const reasoningDisablesTemperature = (s: ReasoningSupport): boolean =>
  s.shape === "anthropic-thinking"

/**
 * Vercel AI SDK `providerOptions` for the egress provider, given a requested tier.
 * Returns undefined when reasoning should be omitted (none shape, or the clamped tier is off).
 */
export const buildProviderOptions = (
  support: ReasoningSupport,
  tier: ThinkingEffort,
): Record<string, unknown> | undefined => {
  const clamped = clampTier(support, tier)
  if (clamped === undefined || clamped === "off") return undefined

  switch (support.shape) {
    case "none":
      return undefined
    case "openai-effort": {
      const effort = OPENAI_EFFORT[clamped]
      return effort === undefined
        ? undefined
        : { openai: { reasoningEffort: effort } }
    }
    case "google-thinking": {
      const budget = GOOGLE_BUDGET[clamped]
      return budget <= 0
        ? undefined
        : { google: { thinkingConfig: { thinkingBudget: budget } } }
    }
    case "anthropic-thinking": {
      // Task 0 finding: @ai-sdk/anthropic@3.0.81 supports { type: "adaptive" }.
      // Adaptive is the modern shape that does NOT 400 on Opus 4.7/4.8/Fable (unlike
      // budget_tokens). The AI SDK anthropic providerOptions has no separate effort
      // field, so tier magnitude is not finely controllable here — adaptive self-regulates;
      // the proxy safe-fallback covers older models (e.g. Sonnet 4.5) that reject adaptive.
      // ANTHROPIC_BUDGET is retained only for reference and is not used here.
      void ANTHROPIC_BUDGET
      return { anthropic: { thinking: { type: "adaptive" } } }
    }
    case "codex-effort":
      // codex-effort is consumed by the native Codex driver, not the AI SDK proxy.
      return undefined
  }
}
