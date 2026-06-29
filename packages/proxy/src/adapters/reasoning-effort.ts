import type { ThinkingEffort } from "@spectrum/agent-events"

/** Map an OpenAI-style reasoning_effort string to a canonical tier. */
export const effortStringToTier = (
  v: string | undefined,
): ThinkingEffort | undefined => {
  switch (v) {
    case "minimal":
      return "minimal"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    default:
      return undefined
  }
}
