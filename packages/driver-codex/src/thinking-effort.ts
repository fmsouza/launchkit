import type { ThinkingEffort } from "@spectrum/agent-events"
import type { ReasoningEffort } from "./bindings/ReasoningEffort"

/** Map the canonical thinking-effort tier onto Codex's native reasoning effort. PURE. */
export const toCodexReasoningEffort = (e: ThinkingEffort): ReasoningEffort => {
  switch (e) {
    case "off":
      return "none"
    case "minimal":
      return "minimal"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "max":
      return "xhigh"
  }
}
