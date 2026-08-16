import type { ProviderDescriptor } from "@spectrum/providers"
import type { ModelHandle } from "./providers/factory"
import type { NormalizedRequest, StreamEvent } from "./types"

/**
 * Per-request context the gateway uses to pick provider-aware behavior. Carries the
 * RESOLVED descriptor rather than a key, so consumers (reasoning shape, streaming
 * profile) read it directly instead of re-resolving through a registry.
 */
export interface StreamContext {
  readonly descriptor: ProviderDescriptor
  readonly providerModel: string
}

export interface LanguageModelGateway {
  stream(
    model: ModelHandle,
    req: NormalizedRequest,
    ctx?: StreamContext,
  ): AsyncIterable<StreamEvent>
}

export type TimeoutWindows = {
  readonly firstTokenTimeoutMs: number
  readonly interTokenTimeoutMs: number
}

export const createScriptedGateway = (
  events: readonly StreamEvent[],
): LanguageModelGateway => ({
  async *stream() {
    for (const e of events) yield e
  },
})
