import type { ThinkingEffort } from "@spectrum/agent-events"
import { type Result, err, ok } from "@spectrum/utils"
import { z } from "zod"
import type {
  NormalizedContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  ProxyError,
} from "../types"
import { effortStringToTier } from "./reasoning-effort"

// content may be a string or an array of blocks; extract text from text
// blocks and ignore the rest (mirrors the Anthropic inbound adapter).
const TextBlock = z.object({ type: z.literal("text"), text: z.string() })
const ContentBlock = z.union([TextBlock, z.object({ type: z.string() })])
const Content = z.union([z.string(), z.array(ContentBlock)])

const flatten = (c: z.infer<typeof Content>): string =>
  typeof c === "string"
    ? c
    : c
        .filter((b): b is z.infer<typeof TextBlock> => b.type === "text")
        .map((b) => b.text)
        .join("")

// An assistant tool call. `arguments` is a JSON STRING (OpenAI encodes the
// tool input as a string); it is parsed below, falling back to {} on failure.
const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
})

// system/user content is a string or array of text blocks. Assistant turns may
// additionally carry tool_calls and a nullable content. Tool turns carry a
// tool_call_id and string/array content (the tool name is omitted by OpenAI).
const Message = z.union([
  z.object({ role: z.literal("system"), content: Content }),
  z.object({ role: z.literal("user"), content: Content }),
  z.object({
    role: z.literal("assistant"),
    content: z.union([Content, z.null()]).optional(),
    tool_calls: z.array(ToolCall).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: Content,
  }),
])
type MessageT = z.infer<typeof Message>

// Top-level tool definitions. Custom tools are function-wrapped; other entry
// shapes (e.g. retrieval) are skipped, as are function entries without a name.
const ToolDef = z.union([
  z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      parameters: z.unknown().optional(),
    }),
  }),
  z.object({ type: z.string() }),
])
type ToolDefT = z.infer<typeof ToolDef>

const OpenAIBody = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  reasoning_effort: z.string().optional(),
  tools: z.array(ToolDef).optional(),
  messages: z.array(Message).min(1),
})

const isSystem = (m: MessageT): m is Extract<MessageT, { role: "system" }> =>
  m.role === "system"

// Parse a tool_call's JSON-string arguments, falling back to {} on failure.
const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// Map top-level tools, skipping non-function entries and function entries
// without a string name; default a missing parameters to an empty object schema.
const mapTools = (tools: ToolDefT[] | undefined): NormalizedTool[] => {
  if (tools === undefined) return []
  const mapped: NormalizedTool[] = []
  for (const t of tools) {
    if (!("function" in t)) continue
    const fn = t.function
    if (typeof fn.name !== "string") continue
    mapped.push({
      name: fn.name,
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      inputSchema: fn.parameters ?? { type: "object" },
    })
  }
  return mapped
}

export const parseOpenAIRequest = (
  body: unknown,
): Result<NormalizedRequest, ProxyError> => {
  const parsed = OpenAIBody.safeParse(body)
  if (!parsed.success)
    return err({ kind: "bad-request", detail: parsed.error.message })
  const b = parsed.data

  const system =
    b.messages
      .filter(isSystem)
      .map((m) => flatten(m.content))
      .join("\n") || undefined

  // Resolve tool names for tool-role messages: OpenAI omits the name on a tool
  // message, so map each tool_call id → name by scanning assistant turns.
  const toolNameById = new Map<string, string>()
  for (const m of b.messages) {
    if (m.role !== "assistant" || m.tool_calls === undefined) continue
    for (const call of m.tool_calls) {
      toolNameById.set(call.id, call.function.name)
    }
  }

  // Build normalized messages, preserving conversation order. An assistant turn
  // with tool_calls becomes structured parts; a tool turn becomes a tool-role
  // message carrying tool-result parts.
  const messages: NormalizedMessage[] = []
  for (const m of b.messages) {
    if (m.role === "system") continue

    if (m.role === "assistant") {
      // content may be a string, an array of blocks, null, or omitted.
      const text =
        m.content === null || m.content === undefined ? "" : flatten(m.content)
      const toolCalls = m.tool_calls ?? []
      if (toolCalls.length === 0) {
        // No tool_calls: keep the existing flattened-string behavior.
        messages.push({ role: "assistant", content: text })
        continue
      }
      const parts: NormalizedContentPart[] = []
      if (text.length > 0) parts.push({ type: "text", text })
      for (const call of toolCalls) {
        parts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          input: parseArguments(call.function.arguments),
        })
      }
      messages.push({ role: "assistant", content: parts })
      continue
    }

    if (m.role === "tool") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: toolNameById.get(m.tool_call_id) ?? "tool",
            output: flatten(m.content),
          },
        ],
      })
      continue
    }

    // role === "user"
    messages.push({ role: "user", content: flatten(m.content) })
  }

  if (messages.length === 0)
    return err({ kind: "bad-request", detail: "no user/assistant messages" })

  const tools = mapTools(b.tools)

  return ok({
    model: b.model,
    ...(system !== undefined ? { system } : {}),
    ...(b.max_tokens !== undefined ? { maxTokens: b.max_tokens } : {}),
    ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...((): { thinkingEffort?: ThinkingEffort } => {
      const t = effortStringToTier(b.reasoning_effort)
      return t !== undefined ? { thinkingEffort: t } : {}
    })(),
    stream: b.stream ?? false,
    messages,
  })
}
