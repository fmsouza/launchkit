import { type Result, ok, isOk, type Clock } from "@launchkit/utils"
import type { Provider } from "@launchkit/types"
import type { ProviderFactory } from "./providers/factory"
import type { LanguageModelGateway } from "./gateway"
import type { NormalizedRequest, ProxyError } from "./types"

/** The outcome of a connectivity probe: whether it succeeded and how long it took. */
export type ProviderTestResult = { readonly ok: boolean; readonly latencyMs: number }

/** A connectivity probe: build the model, stream one cheap token, report ok + latency. */
export type ProviderTester = (
  provider: Provider,
  providerModel: string,
) => Promise<Result<ProviderTestResult, ProxyError>>

/** The minimal probe request: a single short user turn capped at one output token (security/perf). */
const pingRequest = (alias: string): NormalizedRequest => ({
  model: alias,
  messages: [{ role: "user", content: "ping" }],
  maxTokens: 1,
  stream: true,
})

/**
 * Build a provider connectivity tester over the proxy's existing seams. `getModel` resolves the
 * provider (secrets + lazy SDK + cache); `gateway.stream` runs the actual call. Latency is measured
 * with the injected `Clock` (deterministic in tests). A factory failure or a streamed `error` event
 * yields `{ ok: false }` (NOT an `Err` — the probe itself succeeded in determining the provider is
 * unreachable); the `Err<ProxyError>` channel is reserved for a probe that could not run at all.
 * PERFORMANCE/SECURITY: the request is one short message with `maxTokens: 1` — the cheapest probe.
 */
export const createProviderTester = (deps: {
  readonly factory: ProviderFactory
  readonly gateway: LanguageModelGateway
  readonly clock: Clock
}): ProviderTester => {
  return async (provider, providerModel) => {
    const start = deps.clock.now().getTime()

    const model = await deps.factory.getModel(provider, providerModel)
    if (!isOk(model)) {
      // Provider could not be built (bad config / missing secret) → unreachable, latency 0.
      return ok({ ok: false, latencyMs: 0 })
    }

    let streamErrored = false
    try {
      for await (const event of deps.gateway.stream(model.value, pingRequest(providerModel))) {
        if (event.type === "error") streamErrored = true
      }
    } catch {
      streamErrored = true
    }

    const latencyMs = deps.clock.now().getTime() - start
    return ok({ ok: !streamErrored, latencyMs })
  }
}
