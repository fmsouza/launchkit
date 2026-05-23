import { describe, it, expect } from "bun:test"
import { createHandler } from "./handler"
import { createScriptedGateway } from "./gateway"
import { createRouter } from "./router"
import { collectStream } from "./test-helpers"
import type { Config } from "@launchkit/config"

const config = { version: 2, settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
  providers: [{ id: "p1", name: "x", sdkProvider: "openai", config: {}, secrets: {}, models: [] }],
  aliases: [{ alias: "default", providerId: "p1", providerModel: "gpt-4o" }] } as unknown as Config

const deps = (key: string) => ({
  proxyKey: key,
  router: createRouter(config),
  factory: { getModel: async () => ({ ok: true as const, value: {} }) },
  gateway: createScriptedGateway([{ type: "text-delta", text: "Hi" }, { type: "finish", finishReason: "stop" }]),
  listAliases: () => config.aliases.map((a) => a.alias as string),
})

const handler = (key = "k") => createHandler(deps(key))
const post = (path: string, body: unknown, headers: Record<string, string> = { "x-api-key": "k" }) =>
  new Request(`http://localhost:4000${path}`, { method: "POST", headers, body: JSON.stringify(body) })

describe("createHandler", () => {
  it("returns 200 for GET /health regardless of auth", async () => {
    const res = await handler().fetch(new Request("http://localhost:4000/health"))
    expect(res.status).toBe(200)
  })
  it("returns 401 when a /v1/messages request has no proxy key", async () => {
    const res = await handler().fetch(post("/v1/messages", { model: "default", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, {}))
    expect(res.status).toBe(401)
  })
  it("streams Anthropic SSE when a valid /v1/messages request is made", async () => {
    const res = await handler().fetch(post("/v1/messages", { model: "default", max_tokens: 1, stream: true, messages: [{ role: "user", content: "hi" }] }))
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await collectStream(res.body as ReadableStream<Uint8Array>)
    expect(body).toContain("content_block_delta")
    expect(body).toContain("message_stop")
  })
  it("returns 400 when the alias is unknown", async () => {
    const res = await handler().fetch(post("/v1/messages", { model: "ghost", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(400)
  })
  it("lists the configured aliases for GET /v1/models", async () => {
    const res = await handler().fetch(new Request("http://localhost:4000/v1/models", { headers: { "x-api-key": "k" } }))
    const json = await res.json() as { data: { id: string }[] }
    expect(json.data.map((m) => m.id)).toContain("default")
  })
})
