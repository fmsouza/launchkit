import { z } from "zod"

/** The canonical, harness-agnostic thinking-effort tiers, ascending. */
export const THINKING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
] as const

export const ThinkingEffortSchema = z.enum(THINKING_EFFORTS)
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>
