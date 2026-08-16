import {
  buildProviderOptions,
  reasoningDisablesTemperature,
  resolveReasoning,
} from "@spectrum/providers"
import { jsonSchema, streamText } from "ai"
import type {
  LanguageModelGateway,
  StreamContext,
  TimeoutWindows,
} from "../gateway"
import type {
  NormalizedContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  StreamEvent,
} from "../types"
import type { ModelHandle } from "./factory"

/** Reasoning providerOptions for a request, or undefined when none apply. */
export const reasoningOptionsFor = (
  ctx: StreamContext,
  tier: NormalizedRequest["thinkingEffort"],
): Record<string, unknown> | undefined => {
  if (tier === undefined) return undefined
  const support = resolveReasoning(ctx.descriptor, ctx.providerModel)
  return buildProviderOptions(support, tier)
}

/** Heuristic: does this AI SDK error look like a rejected reasoning/thinking parameter? */
export const isUnsupportedReasoningError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const m = `${err.message}`.toLowerCase()
  return (
    /reasoning|thinking|budget_tokens|budgettokens|reasoning_effort/.test(m) &&
    /unsupported|not supported|invalid|unknown|unexpected|400/.test(m)
  )
}

/** The AI SDK `streamText` input `messages` array element type. */
type ModelMessage = NonNullable<
  Parameters<typeof streamText>[0]["messages"]
>[number]
/** The AI SDK `streamText` input `tools` map type. */
type ToolSet = NonNullable<Parameters<typeof streamText>[0]["tools"]>

/**
 * Pure: describe a (possibly nested) AI SDK error as the most useful human-readable detail plus the
 * upstream HTTP status. An `AI_RetryError` unwraps to its last attempt's error; an `AI_APICallError`
 * prefers the provider's own response body (`{"error":"..."}` or `{"error":{"message":"..."}}`) over
 * the generic status text — e.g. Ollama's "you have reached your session usage limit ..." instead of
 * "Too Many Requests".
 */
export const describeStreamError = (
  err: unknown,
): { readonly detail: string; readonly statusCode?: number } => {
  if (err instanceof Error && err.name === "AI_RetryError") {
    const last = (err as { lastError?: unknown }).lastError
    if (last !== undefined) return describeStreamError(last)
  }
  if (err instanceof Error && err.name === "AI_APICallError") {
    const e = err as Error & {
      readonly statusCode?: number
      readonly responseBody?: string
    }
    return {
      detail: providerBodyMessage(e.responseBody) ?? e.message,
      ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
    }
  }
  if (err instanceof Error) {
    const code = (err as { statusCode?: unknown }).statusCode
    return typeof code === "number"
      ? { detail: err.message, statusCode: code }
      : { detail: err.message }
  }
  return { detail: String(err) }
}

/** Pure: extract the message from a provider error body — `{"error":"..."}` or `{"error":{"message":"..."}}`. */
const providerBodyMessage = (body: string | undefined): string | undefined => {
  if (body === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const error = (parsed as { error?: unknown }).error
    if (typeof error === "string") return error
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    )
      return (error as { message: string }).message
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Pure mapping from an AI SDK v6 high-level `fullStream` part to our internal `StreamEvent`.
 * The high-level text-delta part carries its text in `.text` (v4 used `.textDelta`); the high-level
 * `tool-call` part carries the fully-assembled `.input` (the incremental `tool-input-*` parts are
 * skipped). The high-level `finish` part exposes a plain-string `.finishReason` and a `.totalUsage`
 * breakdown ({ inputTokens, outputTokens, totalTokens }). Unknown / incremental part types (e.g.
 * `text-start`/`text-end`/`start`/`finish-step`/`tool-input-delta`/`reasoning-delta`) map to
 * `undefined` and are skipped.
 */
export const mapFullStreamPart = (
  part: { readonly type: string } & Record<string, unknown>,
): StreamEvent | undefined => {
  if (part.type === "text-delta")
    return { type: "text-delta", text: part.text as string }
  if (part.type === "tool-call")
    return {
      type: "tool-call",
      toolCallId: part.toolCallId as string,
      toolName: part.toolName as string,
      input: part.input,
    }
  if (part.type === "finish") {
    const totalUsage = part.totalUsage as
      | { inputTokens?: number; outputTokens?: number }
      | undefined
    return {
      type: "finish",
      finishReason: String(part.finishReason),
      ...(totalUsage !== undefined
        ? {
            usage: {
              inputTokens: Number(totalUsage.inputTokens),
              outputTokens: Number(totalUsage.outputTokens),
            },
          }
        : {}),
    }
  }
  if (part.type === "error")
    return part.error instanceof Error && part.error.name.startsWith("AI_")
      ? { type: "error", ...describeStreamError(part.error) }
      : { type: "error", detail: String(part.error) }
  if (part.type === "abort")
    return {
      type: "error",
      detail: (part as { reason?: string }).reason ?? "LLM request was aborted",
    }
  return undefined
}

/**
 * Pure mapping from a structured `NormalizedContentPart` to an AI SDK message content part.
 * `text` and `tool-call` map 1:1; a `tool-result` carries its string output wrapped as the AI SDK
 * `{ type: "text", value }` tool-output shape. Image and file parts are forwarded with the bytes
 * decoded at the inbound adapter boundary (the AI SDK v6 image/file part fields are `image`/`data`
 * with a `mediaType`).
 */
const toModelContentPart = (
  part: NormalizedContentPart,
): Record<string, unknown> => {
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "image")
    return { type: "image", image: part.data, mediaType: part.mediaType }
  if (part.type === "file")
    return {
      type: "file",
      data: part.data,
      mediaType: part.mediaType,
      ...(part.filename !== undefined ? { filename: part.filename } : {}),
    }
  if (part.type === "tool-call")
    return {
      type: "tool-call",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
    }
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: { type: "text", value: part.output },
  }
}

/**
 * Pure builder for the AI SDK `streamText` `messages` array. String content passes through (the
 * common text case); structured content maps each part to its AI SDK shape (carrying assistant tool
 * calls and `tool`-role tool results). The role is preserved verbatim, including `"tool"`.
 */
export const toModelMessages = (req: NormalizedRequest): ModelMessage[] =>
  req.messages.map((m: NormalizedMessage) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map(toModelContentPart),
  })) as ModelMessage[]

/**
 * Pure builder for the AI SDK `streamText` `tools` map. The proxy is a RELAY: each tool carries its
 * definition (description + JSON Schema input) but NO `execute`, so the model emits tool calls and
 * stops — the harness runs the tool and feeds results back.
 */
export const toModelTools = (tools: readonly NormalizedTool[]): ToolSet =>
  Object.fromEntries(
    tools.map((t) => [
      t.name,
      {
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: jsonSchema(t.inputSchema),
      },
    ]),
  ) as ToolSet

const DEFAULT_TIMEOUTS: TimeoutWindows = {
  firstTokenTimeoutMs: 120_000,
  interTokenTimeoutMs: 60_000,
}

/** A synthetic stall/no-response error carrying a retryable HTTP status so the
 *  outbound serializers map it to a retryable provider error type. */
class StallError extends Error {
  readonly statusCode = 529
  constructor(message: string) {
    super(message)
    this.name = "StallError"
  }
}

/** Build the right stall message for the first-token vs inter-token window. */
const stallError = (
  firstChunkSeen: boolean,
  interTokenTimeoutMs: number,
  firstTokenTimeoutMs: number,
): StallError =>
  firstChunkSeen
    ? new StallError(
        `LLM provider stalled: no further output for ${interTokenTimeoutMs}ms after the last token; check your provider credentials, rate limits, and network`,
      )
    : new StallError(
        `LLM provider did not respond within ${firstTokenTimeoutMs}ms; check your provider credentials, rate limits, and network`,
      )

export const createRealGateway = (opts?: {
  readonly getTimeouts?: (ctx?: StreamContext) => TimeoutWindows
}): LanguageModelGateway => ({
  async *stream(
    model: ModelHandle,
    req: NormalizedRequest,
    ctx?: StreamContext,
  ): AsyncIterable<StreamEvent> {
    // The AI SDK v6's streamText has an unawaited recordSpan() call in its
    // DefaultStreamTextResult constructor. When the LLM provider rejects (e.g. 429),
    // that promise would become a stray unhandled rejection. We absorb it by
    // attaching a rejection handler to `result.text` (see `errorSignal` below),
    // which also gives us a deterministic per-request provider-error signal. Each
    // iterator.next() is raced against a timeout window: the first real (mapped)
    // event is awaited under `firstTokenTimeoutMs`; gaps between subsequent tokens
    // use the shorter `interTokenTimeoutMs`. The error signal short-circuits the
    // pending wait so a real provider error surfaces instantly, without a timer.
    const { firstTokenTimeoutMs, interTokenTimeoutMs } =
      opts?.getTimeouts?.(ctx) ?? DEFAULT_TIMEOUTS

    // Compute reasoning options once (pure; undefined when no thinkingEffort or no ctx).
    const reasoning =
      ctx !== undefined
        ? reasoningOptionsFor(ctx, req.thinkingEffort)
        : undefined
    const dropTemp =
      reasoning !== undefined &&
      ctx !== undefined &&
      reasoningDisablesTemperature(
        resolveReasoning(ctx.descriptor, ctx.providerModel),
      )

    // firstChunkSeen is shared across both run() invocations so the fallback
    // retry is only attempted in the pre-first-chunk window.
    let firstChunkSeen = false

    // Build streamText args (without abortSignal, which is per-attempt).
    // Cast: buildProviderOptions returns Record<string, unknown> (JSON-safe values);
    // streamText providerOptions expects Record<string, JSONObject>. Values are
    // identical — the cast bridges the structural gap introduced by exactOptionalPropertyTypes.
    type StreamTextArgs = Parameters<typeof streamText>[0]
    const buildArgs = (
      withReasoning: boolean,
      signal: AbortSignal,
    ): StreamTextArgs =>
      ({
        model: model as StreamTextArgs["model"],
        ...(req.system !== undefined ? { system: req.system } : {}),
        messages: toModelMessages(req),
        ...(req.tools !== undefined && req.tools.length > 0
          ? { tools: toModelTools(req.tools) }
          : {}),
        ...(req.maxTokens !== undefined
          ? { maxOutputTokens: req.maxTokens }
          : {}),
        // Drop temperature when reasoning forces it (Anthropic extended thinking).
        ...(req.temperature !== undefined && !(withReasoning && dropTemp)
          ? { temperature: req.temperature }
          : {}),
        // Attach reasoning providerOptions when requested for this attempt.
        ...(withReasoning && reasoning !== undefined
          ? { providerOptions: reasoning }
          : {}),
        // The proxy is a RELAY: the harness owns retry policy.
        maxRetries: 0,
        abortSignal: signal,
      }) as StreamTextArgs

    // Inner generator: creates one streamText call (with or without reasoning)
    // and drives its fullStream iterator with timeout + error-signal racing.
    async function* run(withReasoning: boolean): AsyncGenerator<StreamEvent> {
      const controller = new AbortController()

      const result = streamText(buildArgs(withReasoning, controller.signal))

      const iterator = result.fullStream[Symbol.asyncIterator]()

      // Deterministic provider-error signal. In ai@6 a provider rejection surfaces
      // as a rejected `result.text` (and as an `error` part on fullStream). We attach
      // a rejection handler — which ALSO absorbs the AI SDK's stray recordSpan
      // unhandled rejection — and resolve a sentinel so the chunk race can surface the
      // error immediately, without a process-global unhandledRejection listener.
      // This whole design is coupled to AI SDK behavior verified against ai@6.0.194
      // (error part on rejection + `result.text` rejects + `.then` absorbs recordSpan);
      // re-probe these three on any `ai` major/minor bump.
      let capturedError: Error | undefined
      const errorSignal = new Promise<void>((resolve) => {
        void (result.text as Promise<unknown>).then(
          () => {}, // success: leave pending; the iterator drives completion
          (e: unknown) => {
            capturedError = e instanceof Error ? e : new Error(String(e))
            resolve()
          },
        )
      })

      // In ai@6 a provider rejection surfaces BOTH as an `error` part on fullStream
      // (carrying the rich upstream error — e.g. the 429 + provider body) AND as a
      // rejected `result.text` (a generic AI_NoOutputGeneratedError). The fullStream
      // part is authoritative, so once it has been yielded we suppress the redundant
      // `result.text` signal to surface exactly one error event.
      let errorYielded = false
      while (true) {
        type Next = Awaited<ReturnType<typeof iterator.next>>
        if (capturedError !== undefined && !errorYielded) throw capturedError

        const timeoutMs = firstChunkSeen
          ? interTokenTimeoutMs
          : firstTokenTimeoutMs

        const next: Next = await new Promise<Next>((resolve, reject) => {
          const id = setTimeout(() => {
            controller.abort()
            reject(
              stallError(
                firstChunkSeen,
                interTokenTimeoutMs,
                firstTokenTimeoutMs,
              ),
            )
          }, timeoutMs)
          // Surface a deterministic provider error the instant it is captured,
          // unless the fullStream already surfaced (a richer) one.
          void errorSignal.then(() => {
            if (errorYielded) return // the iterator's error part wins; ignore.
            clearTimeout(id)
            reject(capturedError ?? new Error("provider error"))
          })
          void iterator.next().then(
            (val) => {
              clearTimeout(id)
              resolve(val)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (next.done) break
        const event = mapFullStreamPart(
          next.value as { type: string } & Record<string, unknown>,
        )
        if (event !== undefined) {
          firstChunkSeen = true
          if (event.type === "error") errorYielded = true
          yield event
        }
      }
    }

    // Top-level: attempt with reasoning; on a pre-first-chunk unsupported-reasoning
    // error, retry transparently without reasoning. Any other error is surfaced as-is.
    try {
      yield* run(true)
    } catch (e: unknown) {
      if (
        reasoning !== undefined &&
        isUnsupportedReasoningError(e) &&
        !firstChunkSeen
      ) {
        // Safe fallback: the provider rejected the reasoning parameter before
        // any output was streamed — retry without it.
        try {
          yield* run(false)
        } catch (e2: unknown) {
          yield { type: "error", ...describeStreamError(e2) }
        }
      } else {
        yield { type: "error", ...describeStreamError(e) }
      }
    }
  },
})
