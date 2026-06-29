import { THINKING_EFFORTS, type ThinkingEffort } from "@spectrum/agent-events"

/** The per-provider parameter SHAPE a model's reasoning knob takes. */
export type ReasoningShape =
  | "none"
  | "anthropic-thinking"
  | "openai-effort"
  | "google-thinking"
  | "codex-effort"

/** A provider/model's reasoning capability: its param shape + the canonical tiers it accepts. */
export interface ReasoningSupport {
  readonly shape: ReasoningShape
  readonly supportedTiers: readonly ThinkingEffort[]
}

/** All six canonical tiers, ascending — the common "full support" set. */
export const ALL_TIERS: readonly ThinkingEffort[] = [...THINKING_EFFORTS]
