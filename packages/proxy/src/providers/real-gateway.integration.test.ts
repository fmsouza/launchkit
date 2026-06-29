import { describe, expect, it } from "bun:test"
import { APICallError } from "ai"
import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import type { NormalizedRequest, StreamEvent } from "../types"
import { createRealGateway } from "./real-gateway"

describe("createRealGateway", () => {
  it("maps streamText text deltas to normalized text-delta and finish events", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: "Hello" },
            { type: "text-delta" as const, id: "0", delta: " world" },
            { type: "text-end" as const, id: "0" },
            {
              type: "finish" as const,
              // v6 provider-level finish: finishReason is a { unified, raw } object and
              // input/output usage are breakdown objects (LanguageModelV3Usage).
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const gw = createRealGateway()
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req)) events.push(e)
    expect(events[0]).toEqual({ type: "text-delta", text: "Hello" })
    expect(events[1]).toEqual({ type: "text-delta", text: " world" })
    expect(events[2]).toMatchObject({ type: "finish", finishReason: "stop" })
  })

  // Regression: a rate-limited provider must fail FAST with the provider's own
  // message — no AI SDK retry loop (the harness owns retry policy) and no
  // waiting out the 20s chunk timeout to surface the captured rejection.
  it(
    "yields the unwrapped provider error promptly when the provider rejects with a rate limit",
    async () => {
      const model = new MockLanguageModelV3({
        doStream: async () => {
          throw new APICallError({
            message: "Too Many Requests",
            url: "http://127.0.0.1:11434/api/chat",
            requestBodyValues: {},
            statusCode: 429,
            responseBody:
              '{"error":"you have reached your session usage limit"}',
            isRetryable: true,
          })
        },
      })
      const gw = createRealGateway()
      const req: NormalizedRequest = {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }
      const events: StreamEvent[] = []
      for await (const e of gw.stream(model, req)) events.push(e)
      expect(events).toEqual([
        {
          type: "error",
          detail: "you have reached your session usage limit",
          statusCode: 429,
        },
      ])
    },
    // Generous for CI, but far below the AI SDK retry backoff (~6s) +
    // 20s chunk-timeout path this test exists to prevent.
    { timeout: 3000 },
  )

  it("surfaces a provider rejection without registering a process-global unhandledRejection listener", async () => {
    const before = process.listenerCount("unhandledRejection")
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: "Too Many Requests",
          url: "http://127.0.0.1:11434/api/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseBody: '{"error":"you have reached your session usage limit"}',
          isRetryable: true,
        })
      },
    })
    const gw = createRealGateway()
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req)) events.push(e)
    expect(events).toEqual([
      {
        type: "error",
        detail: "you have reached your session usage limit",
        statusCode: 429,
      },
    ])
    expect(process.listenerCount("unhandledRejection")).toBe(before)
  })

  it("times out with the slow-provider message when the first chunk misses the first-token window", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 200, // first chunk arrives AFTER the 80ms window
          chunkDelayInMs: 0,
          chunks: [
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: "hi" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const gw = createRealGateway({
      getTimeouts: () => ({
        firstTokenTimeoutMs: 80,
        interTokenTimeoutMs: 1000,
      }),
    })
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req)) events.push(e)
    expect(events.at(-1)).toMatchObject({ type: "error" })
    expect((events.at(-1) as { detail: string }).detail).toContain(
      "did not respond",
    )
    expect((events.at(-1) as { statusCode?: number }).statusCode).toBe(529)
  })

  it("completes when the first chunk arrives within the first-token window", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 20, // within the 200ms window
          chunkDelayInMs: 5,
          chunks: [
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: "ok" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const gw = createRealGateway({
      getTimeouts: () => ({
        firstTokenTimeoutMs: 200,
        interTokenTimeoutMs: 200,
      }),
    })
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req)) events.push(e)
    expect(events.some((e) => e.type === "text-delta")).toBe(true)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("times out when the gap between chunks exceeds the inter-token window", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 5, // first chunk is fast (passes first-token window)
          chunkDelayInMs: 200, // second chunk is slow (exceeds the 60ms inter-token window)
          chunks: [
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: "part1" },
            { type: "text-delta" as const, id: "0", delta: "part2" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const gw = createRealGateway({
      getTimeouts: () => ({
        firstTokenTimeoutMs: 1000,
        interTokenTimeoutMs: 60,
      }),
    })
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req)) events.push(e)
    expect(events.some((e) => e.type === "text-delta")).toBe(true) // got part1
    // Inter-token stall must use the "stalled" wording (not the first-token "did not respond").
    // toMatchObject with expect.stringContaining mutates the matched object in this bun version,
    // so we snapshot the detail string first, then run the structural assertion.
    const lastEvent = events.at(-1)
    const lastDetail =
      lastEvent !== undefined && "detail" in lastEvent
        ? String((lastEvent as { detail: unknown }).detail)
        : undefined
    expect(lastEvent).toMatchObject({
      type: "error",
      detail: expect.stringContaining("stalled"),
    })
    expect(lastDetail).toEqual(expect.stringContaining("stalled"))
    expect(lastDetail).toEqual(expect.stringContaining("after the last token"))
    expect((lastEvent as { statusCode?: number }).statusCode).toBe(529)
  })

  it("uses provider-aware timeouts from the stream context", async () => {
    const seen: Array<string | undefined> = []
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: "ok" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const gw = createRealGateway({
      getTimeouts: (ctx) => {
        seen.push(ctx?.sdkProvider)
        return { firstTokenTimeoutMs: 1000, interTokenTimeoutMs: 1000 }
      },
    })
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }
    const events: StreamEvent[] = []
    for await (const e of gw.stream(model, req, {
      sdkProvider: "ollama",
      providerModel: "llama3",
    }))
      events.push(e)
    expect(seen).toContain("ollama")
  })
})
