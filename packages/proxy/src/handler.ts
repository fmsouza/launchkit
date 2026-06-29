import { type Logger, createNoopLogger } from "@spectrum/logger"
import { isErr } from "@spectrum/utils"
import { parseAnthropicRequest } from "./adapters/anthropic-request"
import { serializeAnthropicStream } from "./adapters/anthropic-stream"
import { parseOpenAIRequest } from "./adapters/openai-request"
import { serializeOpenAIStream } from "./adapters/openai-stream"
import { parseResponsesRequest } from "./adapters/responses-request"
import { serializeResponsesStream } from "./adapters/responses-stream"
import { checkAuth } from "./auth"
import type { LanguageModelGateway } from "./gateway"
import type { ProviderFactory } from "./providers/factory"
import type { Router } from "./router"
import type { ProxyError, StreamEvent } from "./types"

export interface HandlerDeps {
  proxyKey: string
  router: Router
  factory: ProviderFactory
  gateway: LanguageModelGateway
  listModels: () => readonly string[]
  /** Optional observer (default noop). Logs only `{ kind }` on every error Result: `warn` for client errors (unauthorized/bad-request), `error` for provider/outbound failures. */
  logger?: Logger
}

// Map a ProxyError to the HTTP status the harness sees.
// Provider CLIENT errors (4xx) pass through so the harness handles them directly instead
// of retrying a masked 502 — a permanent config error (404 model-not-found, 400 bad
// request) fails fast, and 429 rate-limit reaches the harness with its true semantics.
// EXCEPTION: a provider 401/403 must NOT reach the harness as 401/403 — it would read
// as a PROXY-auth failure and trigger the ANTHROPIC_AUTH_TOKEN retry loop (see the
// claude harness definition) — so those stay 502. Provider 5xx and unknown statuses
// stay 502 (genuinely retryable/opaque server failures).
const statusFor = (e: ProxyError): number => {
  if (e.kind === "unauthorized") return 401
  if (e.kind === "provider-failed") {
    const sc = e.statusCode
    if (sc !== undefined && sc >= 400 && sc < 500 && sc !== 401 && sc !== 403) {
      return sc
    }
    return 502
  }
  return 400
}
const errorResponse = (e: ProxyError): Response => {
  // The HTTP status line (statusFor) is the authoritative status. Never echo the raw
  // upstream `statusCode` in the body — it would contradict a masked 401/403→502.
  const { statusCode: _statusCode, ...body } = e as ProxyError & {
    statusCode?: number
  }
  return new Response(JSON.stringify({ error: body }), {
    status: statusFor(e),
    headers: { "content-type": "application/json" },
  })
}

/**
 * Peek at the first event yielded by the gateway stream. If it is an error
 * event, tear down the generator and return a 502 JSON error response instead
 * of a 200 SSE stream — so the caller (OpenCode serve / harness) sees a proper
 * HTTP error and can emit a `session.error` / `runner-finished:errored` event.
 * If the stream produces normal data, wrap it back into a chained iterable and
 * pass it to the serializer.
 */
const errorOrStream = async (
  events: AsyncIterable<StreamEvent>,
): Promise<
  | { readonly kind: "stream"; readonly events: AsyncIterable<StreamEvent> }
  | {
      readonly kind: "error"
      readonly detail: string
      readonly statusCode?: number
    }
> => {
  const iter = events[Symbol.asyncIterator]()
  let first: IteratorResult<StreamEvent>
  try {
    first = await iter.next()
  } catch (e) {
    await iter.return?.()
    return {
      kind: "error",
      detail: e instanceof Error ? e.message : "stream generation failed",
    }
  }

  if (first.done) {
    await iter.return?.()
    return { kind: "error", detail: "provider returned no data" }
  }

  if (first.value.type === "error") {
    await iter.return?.()
    return {
      kind: "error",
      detail: first.value.detail,
      ...(first.value.statusCode !== undefined
        ? { statusCode: first.value.statusCode }
        : {}),
    }
  }

  // Chain the first value back in front of the remaining iterable
  const chained: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      let yieldedFirst = false
      return {
        next() {
          if (!yieldedFirst) {
            yieldedFirst = true
            return Promise.resolve({ done: false, value: first.value })
          }
          return iter.next()
        },
        return() {
          return (
            iter.return?.() ?? Promise.resolve({ done: true, value: undefined })
          )
        },
      }
    },
  }

  return { kind: "stream", events: chained }
}

export const createHandler = (
  deps: HandlerDeps,
): { fetch(req: Request): Promise<Response> } => {
  const logger = deps.logger ?? createNoopLogger()
  // Observe every error Result at the response boundary. SECURITY: only the
  // non-sensitive `kind` enum is logged — never the proxyKey, apiKeys, request/
  // response bodies, or the error `detail` (which can echo upstream output).
  // Logging is observation only; the returned `Response` is the sole control-flow signal.
  // Severity by kind: expected client errors (unauthorized/bad-request) log
  // `warn` — a routinely-probed loopback proxy must not spam the error log;
  // provider/outbound/server failures log `error`.
  const isClientError = (k: ProxyError["kind"]): boolean =>
    k === "unauthorized" || k === "bad-request"
  const fail = (e: ProxyError): Response => {
    logger[isClientError(e.kind) ? "warn" : "error"]("proxy request failed", {
      kind: e.kind,
    })
    return errorResponse(e)
  }
  const handleChat = async (
    req: Request,
    parse: (b: unknown) => ReturnType<typeof parseAnthropicRequest>,
    serialize: (
      events: AsyncIterable<StreamEvent>,
      model: string,
    ) => ReadableStream<Uint8Array>,
  ): Promise<Response> => {
    const auth = checkAuth(req.headers, deps.proxyKey)
    if (isErr(auth)) return fail(auth.error)
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return fail({ kind: "bad-request", detail: "invalid JSON" })
    }
    const parsed = parse(body)
    if (isErr(parsed)) return fail(parsed.error)
    const fallbackModelId =
      auth.value.kind === "session" ? auth.value.fallbackModelId : undefined
    const route = deps.router.resolve(
      parsed.value.model,
      fallbackModelId !== undefined ? { fallbackModelId } : {},
    )
    if (isErr(route)) return fail(route.error)
    if (route.value.resolvedVia !== "exact")
      logger.info("proxy model routed via fallback", {
        resolvedVia: route.value.resolvedVia,
        // The requested id is the user's own non-secret config value; bound length defensively.
        requested: parsed.value.model.slice(0, 200),
        routeId: route.value.routeId,
      })
    const model = await deps.factory.getModel(
      route.value.provider,
      route.value.providerModel,
    )
    if (isErr(model)) return fail(model.error)
    const events = deps.gateway.stream(model.value, parsed.value, {
      sdkProvider: route.value.provider.sdkProvider,
      providerModel: route.value.providerModel,
    })
    const checked = await errorOrStream(events)
    if (checked.kind === "error")
      return fail({
        kind: "provider-failed",
        detail: checked.detail,
        ...(checked.statusCode !== undefined
          ? { statusCode: checked.statusCode }
          : {}),
      })
    return new Response(serialize(checked.events, parsed.value.model), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  return {
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/health")
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      if (url.pathname === "/v1/models") {
        if (isErr(checkAuth(req.headers, deps.proxyKey)))
          return fail({ kind: "unauthorized" })
        const data = deps.listModels().map((id) => ({ id, object: "model" }))
        return new Response(JSON.stringify({ object: "list", data }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url.pathname === "/v1/messages")
        return handleChat(req, parseAnthropicRequest, serializeAnthropicStream)
      if (url.pathname === "/v1/chat/completions")
        return handleChat(req, parseOpenAIRequest, serializeOpenAIStream)
      if (url.pathname === "/v1/responses")
        return handleChat(req, parseResponsesRequest, serializeResponsesStream)
      return new Response("not found", { status: 404 })
    },
  }
}
