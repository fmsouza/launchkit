import {
  THINKING_EFFORTS,
  type ThinkingEffort,
  ThinkingEffortSchema,
} from "@spectrum/agent-events"
import { z } from "zod"

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

/**
 * The zod counterpart to `ReasoningSupport`, for validating plugin-contributed descriptors.
 * `ReasoningSupport` stays the hand-written, authoritative type (its `supportedTiers` is
 * `readonly`, which `z.infer` cannot express — see the pin below) so builtin catalog entries
 * keep typing against it unchanged.
 */
export const ReasoningSupportSchema = z
  .object({
    shape: z.enum([
      "none",
      "anthropic-thinking",
      "openai-effort",
      "google-thinking",
      "codex-effort",
    ]),
    supportedTiers: z.array(ThinkingEffortSchema),
  })
  .strict()

// Compile-time pin: keep ReasoningSupportSchema's inferred shape assignable to ReasoningSupport.
// If the schema and the hand-written type drift, this line fails `bun run typecheck`.
const _reasoningSchemaMatchesType: ReasoningSupport = {} as z.infer<
  typeof ReasoningSupportSchema
>

/** All six canonical tiers, ascending — the common "full support" set. */
export const ALL_TIERS: readonly ThinkingEffort[] = [...THINKING_EFFORTS]
