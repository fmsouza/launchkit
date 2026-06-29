import type { ThinkingEffort } from "@spectrum/agent-events"
import { clampTier } from "@spectrum/providers"
import type { ReasoningSupport } from "@spectrum/providers"
import type { ReasoningEffort } from "./bindings/ReasoningEffort"

// Codex models accept the full effort range; clamp guards against future model-specific limits.
const CODEX_SUPPORT: ReasoningSupport = {
  shape: "codex-effort",
  supportedTiers: ["off", "minimal", "low", "medium", "high", "max"],
}

const MAP: Record<Exclude<ThinkingEffort, "off">, ReasoningEffort> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
}

/** Map the canonical tier onto Codex reasoning effort, clamped to supported tiers. undefined = omit. */
export const toCodexReasoningEffort = (
  effort: ThinkingEffort,
  _modelId: string | undefined,
): ReasoningEffort | undefined => {
  const tier = clampTier(CODEX_SUPPORT, effort)
  if (tier === undefined || tier === "off") return undefined
  return MAP[tier]
}
