import { describe, expect, it } from "bun:test"
import { parseOpenAIRequest } from "./openai-request"

describe("parseOpenAIRequest", () => {
  it("maps an OpenAI chat-completions body to a normalized request, lifting the system message", () => {
    const body = {
      model: "fast",
      stream: true,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    }
    expect(parseOpenAIRequest(body)).toEqual({
      ok: true,
      value: {
        model: "fast",
        system: "be terse",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  })
  it("returns bad-request when messages is not an array", () => {
    expect(parseOpenAIRequest({ model: "x", messages: "nope" }).ok).toBe(false)
  })
  it("extracts text from an array content of text blocks", () => {
    const body = {
      model: "fast",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.messages[0]?.content).toBe("ab")
  })
  it("maps top-level function-wrapped tools to normalized tools using function.parameters", () => {
    const body = {
      model: "fast",
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
        // non-function entry: must be skipped
        { type: "retrieval" },
        // function entry without a name: must be skipped
        { type: "function", function: { description: "no name" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseOpenAIRequest(body)
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
  it("omits tools entirely when none are valid", () => {
    const body = {
      model: "fast",
      tools: [{ type: "retrieval" }],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseOpenAIRequest(body)
    expect(r.ok && "tools" in r.value).toBe(false)
  })
  it("maps an assistant tool_calls entry to a tool-call part with parsed arguments", () => {
    const body = {
      model: "fast",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"/a"}' },
            },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    const assistant = r.ok ? r.value.messages[1] : undefined
    expect(assistant?.role).toBe("assistant")
    expect(assistant?.content).toEqual([
      { type: "text", text: "ok" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Read",
        input: { path: "/a" },
      },
    ])
  })
  it("omits the text part when an assistant tool_calls message has null content", () => {
    const body = {
      model: "fast",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"/a"}' },
            },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    const assistant = r.ok ? r.value.messages[1] : undefined
    expect(assistant?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Read",
        input: { path: "/a" },
      },
    ])
  })
  it("falls back to an empty object input when tool_call arguments are not valid JSON", () => {
    const body = {
      model: "fast",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "not json" },
            },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    const assistant = r.ok ? r.value.messages[1] : undefined
    expect(assistant?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Read",
        input: {},
      },
    ])
  })
  it("keeps an assistant message with no tool_calls as a flattened string", () => {
    const body = {
      model: "fast",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "x" },
            { type: "text", text: "y" },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    expect(r.ok && r.value.messages[1]?.content).toBe("xy")
  })
  it("maps a role:tool message to a tool-role message and resolves the name from the prior tool_calls", () => {
    const body = {
      model: "fast",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"/a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "FILE BODY" },
      ],
    }
    const r = parseOpenAIRequest(body)
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
  it("falls back to a generic tool name when the tool_call_id is unresolved", () => {
    const body = {
      model: "fast",
      messages: [{ role: "tool", tool_call_id: "unknown", content: "out" }],
    }
    const r = parseOpenAIRequest(body)
    const toolMsg = r.ok ? r.value.messages[0] : undefined
    expect(toolMsg?.role).toBe("tool")
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "unknown",
        toolName: "tool",
        output: "out",
      },
    ])
  })
  it("maps reasoning_effort to a canonical tier", () => {
    const r = parseOpenAIRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.thinkingEffort).toBe("low")
  })
  it("extracts text from a tool message whose content is an array of text blocks", () => {
    const body = {
      model: "fast",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Grep", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "line1" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    }
    const r = parseOpenAIRequest(body)
    const toolMsg = r.ok ? r.value.messages[1] : undefined
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "Grep",
        output: "line1line2",
      },
    ])
  })
})
