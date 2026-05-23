import { isErr } from "@launchkit/utils"
import { checkAuth } from "./auth"
import { parseAnthropicRequest } from "./adapters/anthropic-request"
import { parseOpenAIRequest } from "./adapters/openai-request"
import { serializeAnthropicStream } from "./adapters/anthropic-stream"
import { serializeOpenAIStream } from "./adapters/openai-stream"
import type { Router } from "./router"
import type { ProviderFactory } from "./providers/factory"
import type { LanguageModelGateway } from "./gateway"
import type { NormalizedRequest, ProxyError } from "./types"

export interface HandlerDeps {
  proxyKey: string
  router: Router
  factory: ProviderFactory
  gateway: LanguageModelGateway
  listAliases: () => readonly string[]
}

const statusFor = (e: ProxyError): number =>
  e.kind === "unauthorized" ? 401 : e.kind === "provider-failed" ? 502 : 400
const errorResponse = (e: ProxyError): Response =>
  new Response(JSON.stringify({ error: e }), { status: statusFor(e), headers: { "content-type": "application/json" } })

export const createHandler = (deps: HandlerDeps): { fetch(req: Request): Promise<Response> } => {
  const handleChat = async (
    req: Request,
    parse: (b: unknown) => ReturnType<typeof parseAnthropicRequest>,
    serialize: (events: AsyncIterable<import("./types").StreamEvent>, model: string) => ReadableStream<Uint8Array>,
  ): Promise<Response> => {
    const auth = checkAuth(req.headers, deps.proxyKey)
    if (isErr(auth)) return errorResponse(auth.error)
    let body: unknown
    try { body = await req.json() } catch { return errorResponse({ kind: "bad-request", detail: "invalid JSON" }) }
    const parsed = parse(body)
    if (isErr(parsed)) return errorResponse(parsed.error)
    const route = deps.router.resolve(parsed.value.model)
    if (isErr(route)) return errorResponse(route.error)
    const model = await deps.factory.getModel(route.value.provider, route.value.providerModel)
    if (isErr(model)) return errorResponse(model.error)
    const events = deps.gateway.stream(model.value, parsed.value)
    return new Response(serialize(events, parsed.value.model), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
  }

  return {
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
      if (url.pathname === "/v1/models") {
        if (isErr(checkAuth(req.headers, deps.proxyKey))) return errorResponse({ kind: "unauthorized" })
        const data = deps.listAliases().map((id) => ({ id, object: "model" }))
        return new Response(JSON.stringify({ object: "list", data }), { headers: { "content-type": "application/json" } })
      }
      if (url.pathname === "/v1/messages") return handleChat(req, parseAnthropicRequest, serializeAnthropicStream)
      if (url.pathname === "/v1/chat/completions") return handleChat(req, parseOpenAIRequest, serializeOpenAIStream)
      return new Response("not found", { status: 404 })
    },
  }
}
