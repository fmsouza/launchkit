import type { ThinkingEffort } from "@spectrum/agent-events"

/**
 * Map the canonical thinking-effort tier onto a Claude max-thinking-tokens budget.
 * `null` disables extended thinking entirely (the "off" tier).
 */
export const toClaudeThinkingBudget = (e: ThinkingEffort): number | null => {
  switch (e) {
    case "off":
      return null
    case "minimal":
      return 1024
    case "low":
      return 4096
    case "medium":
      return 8192
    case "high":
      return 16384
    case "max":
      return 32768
  }
}
