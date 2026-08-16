import { describe, expect, it } from "bun:test"
import type { Config } from "@spectrum/config"
import type { Logger } from "@spectrum/logger"
import { createProviderRegistry } from "@spectrum/providers"
import { createScriptedGateway } from "./gateway"
import { createHandler } from "./handler"
import { createRouter } from "./router"
import { encodeSessionProxyKey } from "./session-token"
import { collectStream } from "./test-helpers"

type Captured = {
  level: "info" | "warn" | "error"
  msg: string
  fields: Record<string, unknown> | undefined
}

const makeFakeLogger = (): {
  logger: Logger
  records: Captured[]
  infosOf: () => Captured[]
  errorsOf: () => Captured[]
} => {
  const records: Captured[] = []
  const logger: Logger = {
    debug: () => {},
    info: (msg, fields) => {
      records.push({ level: "info", msg, fields })
    },
    warn: (msg, fields) => {
      records.push({ level: "warn", msg, fields })
    },
    error: (msg, fields) => {
      records.push({ level: "error", msg, fields })
    },
    fatal: () => {},
    child: () => logger,
  }
  return {
    logger,
    records,
    infosOf: () => records.filter((r) => r.level === "info"),
    errorsOf: () => records.filter((r) => r.level === "error"),
  }
}

const config = {
  version: 2,
  settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
  providers: [
    {
      id: "p1",
      name: "x",
      sdkProvider: "openai",
      config: {},
      secrets: {},
      models: [],
    },
  ],
  models: [{ id: "mdl_default", providerId: "p1", providerModel: "gpt-4o" }],
} as unknown as Config

const deps = (key: string) => ({
  proxyKey: key,
  router: createRouter(config),
  factory: {
    getModel: async () => ({ ok: true as const, value: {} }),
    getModelFromResolved: async () => ({ ok: true as const, value: {} }),
  },
  gateway: createScriptedGateway([
    { type: "text-delta", text: "Hi" },
    { type: "finish", finishReason: "stop" },
  ]),
  listModels: () => config.models.map((m) => m.id as string),
  getDescriptor: createProviderRegistry().get,
})

type MakeDepsOpts = {
  proxyKey: string
  models: Config["models"]
}

const makeDeps = ({ proxyKey, models }: MakeDepsOpts) => {
  const cfg: Config = {
    version: 2,
    settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    providers: [
      {
        id: "p1",
        name: "x",
        sdkProvider: "openai",
        config: {},
        secrets: {},
        models: [],
      },
    ],
    models,
  } as unknown as Config
  return {
    proxyKey,
    router: createRouter(cfg),
    factory: {
      getModel: async () => ({ ok: true as const, value: {} }),
      getModelFromResolved: async () => ({ ok: true as const, value: {} }),
    },
    gateway: createScriptedGateway([
      { type: "text-delta", text: "Hi" },
      { type: "finish", finishReason: "stop" },
    ]),
    listModels: () => models.map((m) => m.id as string),
    getDescriptor: createProviderRegistry().get,
  }
}

const handler = (key = "k") => createHandler(deps(key))
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { "x-api-key": "k" },
) =>
  new Request(`http://localhost:4000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

describe("createHandler", () => {
  it("returns 200 for GET /health regardless of auth", async () => {
    const res = await handler().fetch(
      new Request("http://localhost:4000/health"),
    )
    expect(res.status).toBe(200)
  })
  it("returns 401 when a /v1/messages request has no proxy key", async () => {
    const res = await handler().fetch(
      post(
        "/v1/messages",
        {
          model: "mdl_default",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      ),
    )
    expect(res.status).toBe(401)
  })
  it("streams Anthropic SSE when a valid /v1/messages request is made", async () => {
    const res = await handler().fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await collectStream(res.body as ReadableStream<Uint8Array>)
    expect(body).toContain("content_block_delta")
    expect(body).toContain("message_stop")
  })
  it("streams Responses API SSE when a valid /v1/responses request is made (codex)", async () => {
    const res = await handler().fetch(
      post("/v1/responses", {
        model: "mdl_default",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      }),
    )
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await collectStream(res.body as ReadableStream<Uint8Array>)
    expect(body).toContain("event: response.created")
    expect(body).toContain('"delta":"Hi"')
    expect(body).toContain("event: response.completed")
  })
  it("returns 400 when the model is unknown", async () => {
    const res = await handler().fetch(
      post("/v1/messages", {
        model: "ghost",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(400)
  })
  it("returns 400 unsupported-provider when getDescriptor cannot resolve the route's provider key", async () => {
    const res = await createHandler({
      ...deps("k"),
      getDescriptor: () => undefined,
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      error: { kind: string; sdkProvider: string }
    }
    expect(json.error).toMatchObject({
      kind: "unsupported-provider",
      sdkProvider: "openai",
    })
  })
  it("returns 502 provider-failed when the gateway errors without an upstream status", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "stream failed" },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(502)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({
      kind: "provider-failed",
      detail: "stream failed",
    })
  })
  it("passes through 429 with the provider's detail when the provider is rate limited", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        {
          type: "error",
          detail: "you have reached your session usage limit",
          statusCode: 429,
        },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(429)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({
      kind: "provider-failed",
      detail: "you have reached your session usage limit",
    })
  })
  it("passes through 404 when the provider returns model-not-found so the harness fails fast", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "model not found", statusCode: 404 },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({
      kind: "provider-failed",
      detail: "model not found",
    })
  })
  it("passes through 400 when the provider returns a bad-request error", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "bad request", statusCode: 400 },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({
      kind: "provider-failed",
      detail: "bad request",
    })
  })
  it("masks provider 401 as 502 so it does not trigger the harness auth-retry loop", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "invalid api key", statusCode: 401 },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(502)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({ kind: "provider-failed" })
    expect(json.error).not.toHaveProperty("statusCode")
  })
  it("masks provider 403 as 502 so it does not trigger the harness auth-retry loop", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "forbidden", statusCode: 403 },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(502)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({ kind: "provider-failed" })
    expect(json.error).not.toHaveProperty("statusCode")
  })
  it("returns 502 when the provider returns a 500 server error", async () => {
    const res = await createHandler({
      ...deps("k"),
      gateway: createScriptedGateway([
        { type: "error", detail: "internal server error", statusCode: 500 },
      ]),
    }).fetch(
      post("/v1/messages", {
        model: "mdl_default",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(res.status).toBe(502)
    const json = (await res.json()) as {
      error: { kind: string; detail: string }
    }
    expect(json.error).toMatchObject({ kind: "provider-failed" })
    expect(json.error).not.toHaveProperty("statusCode")
  })
  it("logs error with the kind and no secret when the gateway fails", async () => {
    const { logger, errorsOf } = makeFakeLogger()
    await createHandler({
      ...deps("super-secret-proxy-key"),
      logger,
      gateway: createScriptedGateway([
        { type: "error", detail: "stream failed" },
      ]),
    }).fetch(
      post(
        "/v1/messages",
        {
          model: "mdl_default",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        },
        { "x-api-key": "super-secret-proxy-key" },
      ),
    )
    const errors = errorsOf()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields).toMatchObject({ kind: "provider-failed" })
    const serialized = JSON.stringify(errors)
    expect(serialized).not.toContain("super-secret-proxy-key")
  })
  it("logs an unauthorized client error at warn (not error)", async () => {
    const { logger, records } = makeFakeLogger()
    await createHandler({ ...deps("k"), logger }).fetch(
      post(
        "/v1/messages",
        {
          model: "mdl_default",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      ),
    )
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe("warn")
    expect(records[0]?.fields).toMatchObject({ kind: "unauthorized" })
  })
  it("lists the configured models for GET /v1/models", async () => {
    const res = await handler().fetch(
      new Request("http://localhost:4000/v1/models", {
        headers: { "x-api-key": "k" },
      }),
    )
    const json = (await res.json()) as { data: { id: string }[] }
    expect(json.data.map((m) => m.id)).toContain("mdl_default")
  })
  it("routes an unknown sub-agent model id to the session's selected route (200)", async () => {
    const h = createHandler(
      makeDeps({
        proxyKey: "master",
        models: [
          { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
        ] as Config["models"],
      }),
    )
    const res = await h.fetch(
      new Request("http://x/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${encodeSessionProxyKey("master", "mdl_sel")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    )
    expect(res.status).toBe(200)
  })
  it("still 400s an unknown id when the token carries no session (bare master key)", async () => {
    const h = createHandler(
      makeDeps({
        proxyKey: "master",
        models: [
          { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
        ] as Config["models"],
      }),
    )
    const res = await h.fetch(
      new Request("http://x/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer master",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "ghost",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { kind: string; id?: string } }
    expect(body.error.kind).toBe("unknown-model")
    expect(body.error.id).toBe("ghost")
  })
  it("emits exactly one info log with resolvedVia and routeId (no secret) when a request resolves via session-fallback", async () => {
    const { logger, infosOf } = makeFakeLogger()
    const sessionToken = encodeSessionProxyKey("secret-master-key", "mdl_sel")
    const h = createHandler({
      ...makeDeps({
        proxyKey: "secret-master-key",
        models: [
          { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
        ] as Config["models"],
      }),
      logger,
    })
    const res = await h.fetch(
      new Request("http://x/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    )
    expect(res.status).toBe(200)
    const infos = infosOf()
    expect(infos).toHaveLength(1)
    expect(infos[0]?.msg).toBe("proxy model routed via fallback")
    expect(infos[0]?.fields).toMatchObject({
      resolvedVia: "session-fallback",
      routeId: "mdl_sel",
    })
    const serialized = JSON.stringify(infos)
    expect(serialized).not.toContain("secret-master-key")
    expect(serialized).not.toContain(sessionToken)
  })
  it("does not emit a fallback-routing log when a request resolves via exact id match", async () => {
    const { logger, infosOf } = makeFakeLogger()
    const h = createHandler({
      ...makeDeps({
        proxyKey: "master",
        models: [
          { id: "mdl_sel", providerId: "p1", providerModel: "claude-opus" },
        ] as Config["models"],
      }),
      logger,
    })
    const res = await h.fetch(
      new Request("http://x/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer master",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "mdl_sel",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(infosOf()).toHaveLength(0)
  })
})
