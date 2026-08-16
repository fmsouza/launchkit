import type { SdkProvider } from "@spectrum/types"
import type { ReasoningSupport } from "./reasoning-types"
import type { ProviderDescriptor } from "./types"

const NONE: ReasoningSupport = { shape: "none", supportedTiers: [] }

/**
 * A minimal known-exceptions list: provider + model-id regex → override.
 * First match wins; ordered most-specific first. Unmatched models fall back
 * to the provider-level descriptor default.
 */
const OVERRIDES: ReadonlyArray<{
  readonly provider: SdkProvider
  readonly match: RegExp
  readonly support: ReasoningSupport
}> = [
  // Anthropic Haiku 3.x has no extended thinking (matches claude-3[-N]-haiku-... patterns).
  { provider: "anthropic", match: /claude-3.*haiku/i, support: NONE },
  // OpenAI non-reasoning chat models.
  {
    provider: "openai",
    match: /^(gpt-4o|gpt-4-turbo|gpt-4\b|gpt-3\.5)/i,
    support: NONE,
  },
]

/** Resolve the reasoning capability for a provider descriptor, refined by a model-id override list. */
export const resolveReasoning = (
  descriptor: ProviderDescriptor,
  modelId?: string,
): ReasoningSupport => {
  if (modelId !== undefined) {
    const hit = OVERRIDES.find(
      (o) => o.provider === descriptor.key && o.match.test(modelId),
    )
    if (hit !== undefined) return hit.support
  }
  return descriptor.reasoning
}
