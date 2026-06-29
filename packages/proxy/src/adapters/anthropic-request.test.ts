import { describe, expect, it } from "bun:test"
import { parseAnthropicRequest } from "./anthropic-request"

describe("parseAnthropicRequest", () => {
  it("maps an Anthropic Messages body to a normalized request", () => {
    const body = {
      model: "default",
      max_tokens: 100,
      stream: true,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    }
    expect(parseAnthropicRequest(body)).toEqual({
      ok: true,
      value: {
        model: "default",
        system: "be terse",
        maxTokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  })
  it("flattens Anthropic content blocks into a single text string", () => {
    const body = {
      model: "default",
      max_tokens: 10,
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
    const r = parseAnthropicRequest(body)
    expect(r.ok && r.value.messages[0]?.content).toBe("ab")
  })
  it("returns bad-request when the body is missing messages", () => {
    expect(parseAnthropicRequest({ model: "x", max_tokens: 1 }).ok).toBe(false)
  })
  it("flattens a system array of text blocks into the system string", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok && r.value.system).toContain("A")
    expect(r.ok && r.value.system).toContain("B")
  })
  it("folds a system-role message into the system prompt and keeps only user/assistant in messages", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "sys" },
      ],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok && r.value.messages).toEqual([{ role: "user", content: "hi" }])
    expect(r.ok && r.value.system).toContain("sys")
  })
  it("ignores non-text content blocks and extracts text", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "x" },
            },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.messages[0]?.content).toBe("hello")
  })
  it("ignores unknown top-level fields like metadata", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      metadata: { user_id: "abc" },
      thinking: { type: "enabled", budget_tokens: 1024 },
      context_management: {},
      output_config: {},
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.messages[0]?.content).toBe("hi")
  })
  it("maps top-level tools to normalized tools using input_schema", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        // server-style entry without a string name: must be skipped
        { type: "web_search_20250305" },
      ],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseAnthropicRequest(body)
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
  it("defaults inputSchema to an object schema when a tool lacks input_schema", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      tools: [{ name: "NoSchema" }],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok && r.value.tools).toEqual([
      { name: "NoSchema", inputSchema: { type: "object" } },
    ])
  })
  it("omits tools entirely when none are valid", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      tools: [{ type: "web_search_20250305" }],
      messages: [{ role: "user", content: "hi" }],
    }
    const r = parseAnthropicRequest(body)
    expect(r.ok && "tools" in r.value).toBe(false)
  })
  it("maps assistant tool_use blocks to tool-call parts", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { path: "/a" },
            },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
    const assistant = r.ok ? r.value.messages[1] : undefined
    expect(assistant?.role).toBe("assistant")
    expect(assistant?.content).toEqual([
      { type: "text", text: "ok" },
      {
        type: "tool-call",
        toolCallId: "toolu_1",
        toolName: "Read",
        input: { path: "/a" },
      },
    ])
  })
  it("keeps assistant text-only content as a flattened string", () => {
    const body = {
      model: "default",
      max_tokens: 10,
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
    const r = parseAnthropicRequest(body)
    expect(r.ok && r.value.messages[1]?.content).toBe("xy")
  })
  it("maps a user tool_result into a tool-role message and resolves the tool name from the prior tool_use", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { path: "/a" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "FILE BODY" },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
    // Order preserved: user, assistant(tool-call), tool(tool-result)
    expect(r.ok && r.value.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ])
    const toolMsg = r.ok ? r.value.messages[2] : undefined
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "Read",
        output: "FILE BODY",
      },
    ])
  })
  it("falls back to a generic tool name when the tool_use_id is unresolved", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "unknown", content: "out" },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
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
  it("extracts text from a tool_result whose content is an array of text blocks", () => {
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
            },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
    const toolMsg = r.ok ? r.value.messages[1] : undefined
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "Grep",
        output: "line1line2",
      },
    ])
  })
  it("places the tool-result immediately after the assistant tool_use, before same-turn user text", () => {
    // Claude Code routinely puts a tool_result AND a <system-reminder> text block in the SAME user
    // turn. The tool-result message MUST come directly after the assistant tool_use — an intervening
    // user message orphans the tool call and the AI SDK throws MissingToolResultsError.
    const body = {
      model: "default",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "also note this" },
            { type: "tool_result", tool_use_id: "t1", content: "BODY" },
          ],
        },
      ],
    }
    const r = parseAnthropicRequest(body)
    const roles = r.ok ? r.value.messages.map((m) => m.role) : []
    expect(roles).toEqual(["assistant", "tool", "user"])
    const toolMsg = r.ok ? r.value.messages[1] : undefined
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "Read",
        output: "BODY",
      },
    ])
    expect(r.ok && r.value.messages[2]?.content).toBe("also note this")
  })

  it("parses a tool_result with non-text content blocks (e.g. an image) instead of dropping it", () => {
    const r = parseAnthropicRequest({
      model: "default",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Screenshot", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "captured" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "x",
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Must still be a correlated tool-result (text extracted, id preserved) — not dropped/orphaned.
    const tool = r.value.messages.find((m) => m.role === "tool")
    expect(Array.isArray(tool?.content) && tool.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "t1",
      output: "captured",
    })
  })

  it("maps an inbound enabled-thinking budget to a canonical tier", () => {
    const r = parseAnthropicRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.thinkingEffort).toBe("medium")
  })

  it("leaves thinkingEffort undefined when no thinking block is present", () => {
    const r = parseAnthropicRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.thinkingEffort).toBeUndefined()
  })
})
