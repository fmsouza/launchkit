import type { SdkProvider } from "@spectrum/types"
import type { ModelHandle } from "./providers/factory"
import type { NormalizedRequest, StreamEvent } from "./types"

/** Per-request context the gateway uses to pick provider-aware behavior. */
export interface StreamContext {
  readonly sdkProvider: SdkProvider
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
