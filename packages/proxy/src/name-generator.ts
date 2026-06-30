import type { Config, ConfigStore } from "@spectrum/config"
import type { Logger } from "@spectrum/logger"
import type { ModelId, ModelRoute, Provider } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { Clock } from "@spectrum/utils"
import { generateText as defaultGenerateText } from "ai"
import type { ProviderFactory } from "./providers/factory"
import { buildNamePrompt } from "./session-name-prompt"

export type NameGenError =
  | { readonly kind: "no-model-selected" }
  | { readonly kind: "route-not-found" }
  | { readonly kind: "provider-not-found" }
  | { readonly kind: "model-unavailable"; readonly detail?: string }
  | { readonly kind: "generation-failed"; readonly detail?: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "aborted" }

/** Max ms to wait for the naming model before treating it as a timeout. */
export const NAME_GEN_TIMEOUT_MS = 10_000
/** Max chars of a generated session name. */
export const NAME_MAX_CHARS = 50
/** Max output tokens requested from the model (a 6-word title is ~30 tokens). */
export const NAME_GEN_MAX_TOKENS = 32

export interface NameGeneratorDeps {
  readonly config: ConfigStore
  readonly factory: ProviderFactory
  readonly clock: Clock
  readonly logger?: Logger
  /** Override for tests; defaults to the real `generateText` from "ai". */
  readonly generateText?: (opts: {
    readonly model: unknown
    readonly system: string
    readonly prompt: string
    readonly maxOutputTokens: number
    readonly maxRetries: number
    readonly abortSignal: AbortSignal
  }) => Promise<{ readonly text: string }>
}

export interface NameGenerator {
  generate(
    modelId: ModelId,
    firstPrompt: string,
    signal: AbortSignal,
  ): Promise<Result<string, NameGenError>>
}

const capName = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_CHARS)

export const createNameGenerator = (deps: NameGeneratorDeps): NameGenerator => {
  const logger = deps.logger
  const generateText = deps.generateText ?? defaultGenerateText

  const generate: NameGenerator["generate"] = async (
    modelId,
    firstPrompt,
    signal,
  ) => {
    if (signal.aborted) return err({ kind: "aborted" })

    const loaded = await deps.config.load()
    if (!loaded.ok) return err({ kind: "route-not-found" })
    const cfg: Config = loaded.value
    const route: ModelRoute | undefined = cfg.models.find(
      (m) => m.id === modelId,
    )
    if (route === undefined) return err({ kind: "route-not-found" })
    const provider: Provider | undefined = cfg.providers.find(
      (p) => p.id === route.providerId,
    )
    if (provider === undefined) return err({ kind: "provider-not-found" })

    const model = await deps.factory.getModel(provider, route.providerModel)
    if (!model.ok) {
      logger?.warn("session name model unavailable", {
        kind: "model-unavailable",
      })
      return err({ kind: "model-unavailable", detail: model.error.kind })
    }

    const { system, user } = buildNamePrompt(firstPrompt)

    // Layer a timeout controller on the caller's signal so we can force-abort.
    const timeoutCtl = new AbortController()
    const onAbort = (): void => timeoutCtl.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    const startedAt = deps.clock.now().getTime()
    const timer = setInterval(() => {
      const elapsed = deps.clock.now().getTime() - startedAt
      if (elapsed >= NAME_GEN_TIMEOUT_MS) timeoutCtl.abort()
    }, 1000)

    try {
      if (signal.aborted) return err({ kind: "aborted" })
      // Cast: model.value is `unknown` (ModelHandle); real `generateText` expects the
      // AI SDK's LanguageModel type. The local `generateText` is a union of the test
      // stub and the real AI SDK function, so we reference the real function's
      // parameter type directly to resolve the LanguageModel type.
      type RealGenerateTextArgs = Parameters<typeof defaultGenerateText>[0]
      const result = await generateText({
        model: model.value as RealGenerateTextArgs["model"],
        system,
        prompt: user,
        maxOutputTokens: NAME_GEN_MAX_TOKENS,
        maxRetries: 0,
        abortSignal: timeoutCtl.signal,
      })
      if (signal.aborted) return err({ kind: "aborted" })
      if (timeoutCtl.signal.aborted) {
        logger?.warn("session name generation timed out", { kind: "timed-out" })
        return err({ kind: "timed-out" })
      }
      const name = capName(result.text)
      if (name === "") {
        logger?.warn("session name generation returned empty", {
          kind: "generation-failed",
        })
        return err({ kind: "generation-failed", detail: "empty" })
      }
      return ok(name)
    } catch (cause) {
      if (timeoutCtl.signal.aborted && !signal.aborted) {
        logger?.warn("session name generation timed out", { kind: "timed-out" })
        return err({ kind: "timed-out" })
      }
      if (signal.aborted || timeoutCtl.signal.aborted) {
        logger?.warn("session name generation aborted", { kind: "aborted" })
        return err({ kind: "aborted" })
      }
      const detail = cause instanceof Error ? cause.message : "unknown error"
      logger?.warn("session name generation failed", {
        kind: "generation-failed",
      })
      return err({ kind: "generation-failed", detail })
    } finally {
      clearInterval(timer)
      signal.removeEventListener("abort", onAbort)
    }
  }

  return { generate }
}
