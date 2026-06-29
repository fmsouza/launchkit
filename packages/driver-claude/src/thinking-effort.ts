import type { ThinkingEffort } from "@spectrum/agent-events"
import { clampTier, resolveReasoning } from "@spectrum/providers"

/** Claude Code SDK effort levels (subset we emit). Mirrors EffortLevel in the SDK. */
type ClaudeEffort = "low" | "medium" | "high" | "max"

/** The pieces this mapper contributes to the SDK `query` options (or null to omit thinking). */
export type ClaudeThinkingOptions = {
  readonly thinking: { readonly type: "adaptive" }
  readonly effort: ClaudeEffort
} | null

// Canonical tier → Claude effort (no "minimal" effort level → fold to "low").
const EFFORT: Record<Exclude<ThinkingEffort, "off">, ClaudeEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
}

/**
 * Map the canonical tier onto the Claude Code SDK thinking/effort options, gated by the
 * selected model's capability. Returns null to omit thinking entirely (off tier, or a
 * model with no extended thinking — e.g. Haiku 3.x). The native Claude harness always
 * targets Anthropic, so capability is resolved against the "anthropic" provider.
 */
export const toClaudeThinking = (
  effort: ThinkingEffort,
  modelId: string | undefined,
): ClaudeThinkingOptions => {
  const support = resolveReasoning("anthropic", modelId)
  const tier = clampTier(support, effort)
  if (tier === undefined || tier === "off") return null
  return { thinking: { type: "adaptive" }, effort: EFFORT[tier] }
}
