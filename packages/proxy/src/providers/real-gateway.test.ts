import { describe, expect, it } from "bun:test"
import { APICallError, RetryError } from "ai"
import type { NormalizedRequest } from "../types"
import {
  describeStreamError,
  isUnsupportedReasoningError,
  mapFullStreamPart,
  reasoningOptionsFor,
  toModelMessages,
} from "./real-gateway"

const rateLimitError = (responseBody: string): APICallError =>
  new APICallError({
    message: "Too Many Requests",
    url: "http://127.0.0.1:11434/api/chat",
    requestBodyValues: {},
    statusCode: 429,
    responseBody,
    isRetryable: true,
  })

describe("describeStreamError", () => {
  it("surfaces the provider's JSON error string and status from an APICallError", () => {
    expect(
      describeStreamError(
        rateLimitError('{"error":"you have reached your session usage limit"}'),
      ),
    ).toEqual({
      detail: "you have reached your session usage limit",
      statusCode: 429,
    })
  })

  it("unwraps an AI_RetryError to its last APICallError's provider message", () => {
    const inner = rateLimitError('{"error":"quota exhausted"}')
    expect(
      describeStreamError(
        new RetryError({
          message: "Failed after 3 attempts. Last error: Too Many Requests",
          reason: "maxRetriesExceeded",
          errors: [inner],
        }),
      ),
    ).toEqual({ detail: "quota exhausted", statusCode: 429 })
  })

  it("surfaces a nested {error:{message}} provider body shape", () => {
    expect(
      describeStreamError(
        rateLimitError(
          '{"error":{"message":"rate limited","type":"rate_limit_error"}}',
        ),
      ),
    ).toEqual({ detail: "rate limited", statusCode: 429 })
  })

  it("falls back to the error message when the body is not JSON", () => {
    expect(describeStreamError(rateLimitError("<html>busy</html>"))).toEqual({
      detail: "Too Many Requests",
      statusCode: 429,
    })
  })

  it("returns the message of a plain Error without a status", () => {
    expect(describeStreamError(new Error("boom"))).toEqual({ detail: "boom" })
  })

  it("stringifies non-Error values", () => {
    expect(describeStreamError("nope")).toEqual({ detail: "nope" })
  })
})

describe("mapFullStreamPart", () => {
  it("maps a high-level text-delta part (carrying `text`) to a text-delta event", () => {
    expect(mapFullStreamPart({ type: "text-delta", text: "hi" })).toEqual({
      type: "text-delta",
      text: "hi",
    })
  })

  it("maps a tool-call part to a tool-call event carrying the assembled input", () => {
    expect(
      mapFullStreamPart({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
        input: { city: "Berlin" },
      }),
    ).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "get_weather",
      input: { city: "Berlin" },
    })
  })

  it("maps a finish part to a finish event with stringified reason", () => {
    expect(mapFullStreamPart({ type: "finish", finishReason: "stop" })).toEqual(
      { type: "finish", finishReason: "stop" },
    )
  })

  it("maps a finish part with totalUsage to a finish event carrying usage tokens", () => {
    expect(
      mapFullStreamPart({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
      }),
    ).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 11 },
    })
  })

  it("maps an error part to an error event", () => {
    expect(
      mapFullStreamPart({ type: "error", error: new Error("boom") }),
    ).toEqual({ type: "error", detail: "Error: boom" })
  })

  it("unwraps an AI_ error part to the provider's message and status", () => {
    expect(
      mapFullStreamPart({
        type: "error",
        error: rateLimitError('{"error":"session usage limit reached"}'),
      }),
    ).toEqual({
      type: "error",
      detail: "session usage limit reached",
      statusCode: 429,
    })
  })

  it("returns undefined for unknown part types", () => {
    expect(mapFullStreamPart({ type: "text-start" })).toBeUndefined()
  })

  it("returns undefined for tool-input-delta parts (streamed, not assembled)", () => {
    expect(
      mapFullStreamPart({ type: "tool-input-delta", delta: "{" }),
    ).toBeUndefined()
  })

  it("returns undefined for reasoning-delta parts", () => {
    expect(
      mapFullStreamPart({ type: "reasoning-delta", text: "thinking" }),
    ).toBeUndefined()
  })

  it("returns undefined for start parts", () => {
    expect(mapFullStreamPart({ type: "start" })).toBeUndefined()
  })

  it("maps an abort part to an error event carrying the abort reason", () => {
    expect(
      mapFullStreamPart({
        type: "abort",
        reason: "LLM provider timed out",
      }),
    ).toEqual({ type: "error", detail: "LLM provider timed out" })
  })

  it("maps an abort part without a reason to a generic error", () => {
    expect(mapFullStreamPart({ type: "abort" })).toEqual({
      type: "error",
      detail: "LLM request was aborted",
    })
  })
})

describe("toModelMessages", () => {
  it("passes a string-content user message through unchanged", () => {
    const req: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }
    expect(toModelMessages(req)).toEqual([{ role: "user", content: "hello" }])
  })

  it("maps an assistant message with [text, tool-call] parts to AI SDK parts", () => {
    const req: NormalizedRequest = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "get_weather",
              input: { city: "Berlin" },
            },
          ],
        },
      ],
      stream: true,
    }
    expect(toModelMessages(req)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: { city: "Berlin" },
          },
        ],
      },
    ])
  })

  it("maps a tool-role message with a tool-result part to the AI SDK text-output shape", () => {
    const req: NormalizedRequest = {
      model: "m",
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "get_weather",
              output: "sunny",
            },
          ],
        },
      ],
      stream: true,
    }
    expect(toModelMessages(req)).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "get_weather",
            output: { type: "text", value: "sunny" },
          },
        ],
      },
    ])
  })

  it("maps a normalized image part to an AI SDK image part", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const req: NormalizedRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: bytes, mediaType: "image/png" },
          ],
        },
      ],
      stream: true,
    }
    const msgs = toModelMessages(req)
    const content = msgs[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: "text", text: "describe" })
    expect(content[1]?.type).toBe("image")
    expect(content[1]?.image).toBe(bytes)
    expect(content[1]?.mediaType).toBe("image/png")
  })

  it("maps a normalized file part to an AI SDK file part (with optional filename)", () => {
    const bytes = new Uint8Array([4, 5])
    const req: NormalizedRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: bytes,
              mediaType: "application/pdf",
              filename: "doc.pdf",
            },
          ],
        },
      ],
      stream: true,
    }
    const msgs = toModelMessages(req)
    const content = msgs[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe("file")
    expect(content[0]?.data).toBe(bytes)
    expect(content[0]?.mediaType).toBe("application/pdf")
    expect(content[0]?.filename).toBe("doc.pdf")
  })

  it("maps a normalized file part without a filename (omits the key)", () => {
    const bytes = new Uint8Array([6])
    const req: NormalizedRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "file", data: bytes, mediaType: "text/plain" }],
        },
      ],
      stream: true,
    }
    const msgs = toModelMessages(req)
    const content = msgs[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe("file")
    expect(content[0]?.mediaType).toBe("text/plain")
    expect("filename" in (content[0] ?? {})).toBe(false)
  })
})

describe("reasoningOptionsFor", () => {
  it("returns undefined when the request has no thinkingEffort", () => {
    expect(
      reasoningOptionsFor(
        { sdkProvider: "openai", providerModel: "gpt-5" },
        undefined,
      ),
    ).toBeUndefined()
  })

  it("builds openai reasoning options for a tier", () => {
    expect(
      reasoningOptionsFor(
        { sdkProvider: "openai", providerModel: "gpt-5" },
        "low",
      ),
    ).toEqual({ openai: { reasoningEffort: "low" } })
  })

  it("returns undefined for a non-reasoning model (override → none)", () => {
    expect(
      reasoningOptionsFor(
        { sdkProvider: "openai", providerModel: "gpt-4o" },
        "high",
      ),
    ).toBeUndefined()
  })
})

describe("isUnsupportedReasoningError", () => {
  it("flags an API error mentioning the reasoning/thinking parameter", () => {
    const e = Object.assign(new Error("budget_tokens: unsupported parameter"), {
      name: "AI_APICallError",
    })
    expect(isUnsupportedReasoningError(e)).toBe(true)
  })

  it("does not flag an unrelated error", () => {
    expect(isUnsupportedReasoningError(new Error("rate limited"))).toBe(false)
  })
})
