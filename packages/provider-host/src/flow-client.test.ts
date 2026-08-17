import { describe, expect, it } from "bun:test"
import { err, ok } from "@spectrum/utils"
import { createFetchFlowHttp, createFlowClient } from "./flow-client"
import { HOST_TOKEN_HEADER } from "./host-token"

const validResponse = {
  sessionId: "s1",
  step: { kind: "form", title: "Sign in", fields: [] },
}

describe("createFlowClient", () => {
  it("posts to the start path with the host token header", async () => {
    const calls: { url: string; hostToken: string | undefined }[] = []
    const client = createFlowClient({
      http: async (i) => {
        calls.push({ url: i.url, hostToken: i.hostToken })
        return ok(validResponse)
      },
    })
    await client.start(
      "http://127.0.0.1:9000",
      "tok",
      "signin",
      {
        context: "create",
        config: {},
      },
      60_000,
    )
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:9000/spectrum/v1/flow/signin/start",
    )
    expect(calls[0]?.hostToken).toBe("tok")
  })

  it("posts to the next path when advancing", async () => {
    const calls: string[] = []
    const client = createFlowClient({
      http: async (i) => {
        calls.push(i.url)
        return ok(validResponse)
      },
    })
    await client.next(
      "http://127.0.0.1:9000",
      "tok",
      "signin",
      {
        sessionId: "s1",
        result: { kind: "ack" },
      },
      60_000,
    )
    expect(calls[0]).toBe("http://127.0.0.1:9000/spectrum/v1/flow/signin/next")
  })

  it("returns the parsed response when the plugin answers correctly", async () => {
    const client = createFlowClient({ http: async () => ok(validResponse) })
    const r = await client.start(
      "http://127.0.0.1:9000",
      "tok",
      "signin",
      {},
      60_000,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.step.kind).toBe("form")
  })

  it("validates the response and fails when the step kind is unknown", async () => {
    const client = createFlowClient({
      http: async () => ok({ sessionId: "s", step: { kind: "teleport" } }),
    })
    const r = await client.next(
      "http://127.0.0.1:9000",
      "tok",
      "signin",
      {},
      60_000,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("strips a trailing slash from the base url so the path never doubles", async () => {
    const calls: string[] = []
    const client = createFlowClient({
      http: async (i) => {
        calls.push(i.url)
        return ok(validResponse)
      },
    })
    await client.start("http://127.0.0.1:9000/", "tok", "signin", {}, 60_000)
    expect(calls[0]).toBe("http://127.0.0.1:9000/spectrum/v1/flow/signin/start")
  })

  it("propagates a transport failure unchanged", async () => {
    const client = createFlowClient({
      http: async () => err({ kind: "read-failed", detail: "socket closed" }),
    })
    const r = await client.start(
      "http://127.0.0.1:9000",
      "tok",
      "signin",
      {},
      60_000,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })

  it("passes the caller's remaining budget through to the transport", async () => {
    const seen: number[] = []
    const client = createFlowClient({
      http: async (i) => {
        seen.push(i.timeoutMs)
        return ok(validResponse)
      },
    })
    await client.next("http://127.0.0.1:9000", "tok", "signin", {}, 1234)
    expect(seen).toEqual([1234])
  })

  it("passes the host token through as undefined when there is none", async () => {
    const calls: (string | undefined)[] = []
    const client = createFlowClient({
      http: async (i) => {
        calls.push(i.hostToken)
        return ok(validResponse)
      },
    })
    await client.start("http://127.0.0.1:9000", undefined, "signin", {}, 60_000)
    expect(calls[0]).toBeUndefined()
  })
})

describe("createFetchFlowHttp", () => {
  it("fails with read-failed when the response body exceeds the byte cap", async () => {
    // Valid, well-formed JSON that is one byte past FLOW_LIMITS.maxBodyBytes (262_144) — if
    // the cap were not enforced this would parse and succeed, so the test actually exercises
    // the cap rather than piggybacking on a JSON.parse failure from malformed filler text.
    const server = Bun.serve({
      port: 0,
      fetch() {
        const padding = "a".repeat(262_144 + 1)
        return new Response(JSON.stringify({ sessionId: "s", padding }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const http = createFetchFlowHttp()
      const r = await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: {},
        hostToken: undefined,
        timeoutMs: 5_000,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("read-failed")
    } finally {
      server.stop(true)
    }
  })

  it("fails with read-failed when the plugin never answers within the deadline", async () => {
    // Driven through the injected `fetch` because Bun's TEST RUNNER does not propagate a
    // fetch abort to the pending promise (verified: the same abort against a real hung
    // `Bun.serve` rejects in ~52 ms under `bun <script>` and never settles under
    // `bun test`). The seam pins what this adapter owns — that a signal is supplied and
    // that it fires at `timeoutMs` — without depending on that runner quirk.
    const http = createFetchFlowHttp({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"))
          })
        }),
    })
    const started = Date.now()
    const r = await http({
      url: "http://127.0.0.1:9/anything",
      body: {},
      hostToken: undefined,
      timeoutMs: 30,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it("supplies an un-aborted signal when the plugin answers in time", async () => {
    const seen: { aborted: boolean }[] = []
    const http = createFetchFlowHttp({
      fetch: async (_url, init) => {
        seen.push({ aborted: init.signal.aborted })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    const r = await http({
      url: "http://127.0.0.1:9/anything",
      body: {},
      hostToken: undefined,
      timeoutMs: 30_000,
    })
    expect(r.ok).toBe(true)
    expect(seen).toEqual([{ aborted: false }])
  })

  it("fails with read-failed on a non-2xx status rather than parsing the body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ sessionId: "s" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const http = createFetchFlowHttp()
      const r = await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: {},
        hostToken: undefined,
        timeoutMs: 5_000,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("read-failed")
    } finally {
      server.stop(true)
    }
  })

  it("fails with read-failed on a 2xx response with no body", async () => {
    // A 204 is 2xx (response.ok is true) but the spec forbids a body, so response.body is
    // null — this exercises the branch below the status check, not the status check itself.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 204 })
      },
    })
    try {
      const http = createFetchFlowHttp()
      const r = await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: {},
        hostToken: undefined,
        timeoutMs: 5_000,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("read-failed")
    } finally {
      server.stop(true)
    }
  })

  it("sends the host token header when a token is supplied", async () => {
    const captured: { seen: string | null } = { seen: null }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        captured.seen = req.headers.get(HOST_TOKEN_HEADER)
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const http = createFetchFlowHttp()
      await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: {},
        hostToken: "tok-123",
        timeoutMs: 5_000,
      })
      expect(captured.seen).toBe("tok-123")
    } finally {
      server.stop(true)
    }
  })

  it("sends no host token header at all when the token is undefined", async () => {
    const captured: { seen: boolean | null } = { seen: null }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        captured.seen = req.headers.has(HOST_TOKEN_HEADER)
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const http = createFetchFlowHttp()
      await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: {},
        hostToken: undefined,
        timeoutMs: 5_000,
      })
      expect(captured.seen).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it("sets the JSON content type and sends the caller's body", async () => {
    const captured: { contentType: string | null; body: unknown } = {
      contentType: null,
      body: null,
    }
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.contentType = req.headers.get("content-type")
        captured.body = await req.json()
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const http = createFetchFlowHttp()
      await http({
        url: `http://127.0.0.1:${server.port}/anything`,
        body: { a: 1 },
        hostToken: undefined,
        timeoutMs: 5_000,
      })
      expect(captured.contentType).toBe("application/json")
      expect(captured.body).toEqual({ a: 1 })
    } finally {
      server.stop(true)
    }
  })
})
