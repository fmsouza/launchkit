import { describe, expect, it } from "bun:test"
import { parseResponsesRequest } from "./responses-request"

describe("parseResponsesRequest", () => {
  it("maps instructions + a user message (input_text) to system + one user message", () => {
    const body = {
      model: "default",
      instructions: "be terse",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    }
    expect(parseResponsesRequest(body)).toEqual({
      ok: true,
      value: {
        model: "default",
        system: "be terse",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  })

  it("maps flat Responses tools to normalized tools using parameters", () => {
    const body = {
      model: "default",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
          strict: false,
        },
        // not a function tool: must be skipped
        { type: "web_search" },
      ],
    }
    const r = parseResponsesRequest(body)
    expect(r.ok && r.value.tools).toEqual([
      {
        name: "Read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ])
  })

  it("maps a function_call item to an assistant tool-call part (arguments JSON string parsed)", () => {
    const body = {
      model: "default",
      input: [
        { type: "message", role: "user", content: "read it" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "Read",
          arguments: '{"path":"/a"}',
        },
      ],
    }
    const r = parseResponsesRequest(body)
    const assistant = r.ok ? r.value.messages[1] : undefined
    expect(assistant?.role).toBe("assistant")
    expect(assistant?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Read",
        input: { path: "/a" },
      },
    ])
  })

  it("maps a function_call_output item to a tool-role message, resolving the name from the prior function_call with the same call_id", () => {
    const body = {
      model: "default",
      input: [
        { type: "message", role: "user", content: "read it" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "Read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "FILE BODY",
        },
      ],
    }
    const r = parseResponsesRequest(body)
    expect(r.ok && r.value.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ])
    const toolMsg = r.ok ? r.value.messages[2] : undefined
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "Read",
        output: "FILE BODY",
      },
    ])
  })

  it("ignores unknown item types (reasoning) and unknown top-level keys", () => {
    const body = {
      model: "default",
      reasoning: { effort: "high" },
      store: false,
      include: [],
      parallel_tool_calls: true,
      prompt_cache_key: "abc",
      input: [
        { type: "reasoning", summary: [] },
        { type: "message", role: "user", content: "hi" },
      ],
    }
    const r = parseResponsesRequest(body)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.messages).toEqual([{ role: "user", content: "hi" }])
  })
  it("maps reasoning.effort to a canonical tier", () => {
    const r = parseResponsesRequest({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.thinkingEffort).toBe("high")
  })
})
