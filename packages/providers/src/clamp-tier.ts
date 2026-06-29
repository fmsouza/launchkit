import { THINKING_EFFORTS, type ThinkingEffort } from "@spectrum/agent-events"
import type { ReasoningSupport } from "./reasoning-types"

const rank = (t: ThinkingEffort): number => THINKING_EFFORTS.indexOf(t)

/**
 * The highest supported tier whose rank is ≤ the requested tier's rank.
 * Returns undefined when the shape is `none` or nothing qualifies.
 */
export const clampTier = (
  support: ReasoningSupport,
  tier: ThinkingEffort,
): ThinkingEffort | undefined => {
  if (support.shape === "none" || support.supportedTiers.length === 0)
    return undefined
  const want = rank(tier)
  const eligible = support.supportedTiers.filter((t) => rank(t) <= want)
  if (eligible.length === 0) return undefined
  return eligible.reduce((best, t) => (rank(t) > rank(best) ? t : best))
}
