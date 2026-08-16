import { type Result, err, ok } from "@spectrum/utils"
import type { ProviderRegistry } from "./registry"
import type { ProviderConfigError } from "./types"

/**
 * Validate a provider's NON-secret config against its descriptor's schema.
 * Keys no descriptor claims yield `unsupported-provider`; schema failures yield `bad-request`.
 */
export const validateProviderConfig = (
  registry: ProviderRegistry,
  sdkProvider: string,
  config: unknown,
): Result<void, ProviderConfigError> => {
  const descriptor = registry.get(sdkProvider)
  if (descriptor === undefined)
    return err({ kind: "unsupported-provider", sdkProvider })
  const parsed = descriptor.configSchema.safeParse(config)
  if (!parsed.success)
    return err({ kind: "bad-request", detail: parsed.error.message })
  return ok(undefined)
}
