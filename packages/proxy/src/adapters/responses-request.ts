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

// A message content text block. Responses uses input_text (user/developer) and
// output_text (assistant); both carry a `text` string. Other parts (e.g.
// input_image) are matched by the catch-all branch below and ignored.
const InputTextBlock = z.object({
  type: z.literal("input_text"),
  text: z.string(),
})
const OutputTextBlock = z.object({
  type: z.literal("output_text"),
  text: z.string(),
})
const MessageContentBlock = z.union([
  InputTextBlock,
  OutputTextBlock,
  z.object({ type: z.string() }),
])
type MessageContentBlockT = z.infer<typeof MessageContentBlock>
const MessageContent = z.union([z.string(), z.array(MessageContentBlock)])

// input items, discriminated by `type`. Each schema is non-strict so extra
// provider keys (e.g. `id`, `status`) are tolerated and ignored.
const MessageItem = z.object({
  type: z.literal("message"),
  role: z.enum(["developer", "system", "user", "assistant"]),
  content: MessageContent,
})
const FunctionCallItem = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
})
const FunctionCallOutputItem = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  // output is a string or an arbitrary JSON object; stringify the latter.
  output: z.unknown(),
})
const InputItem = z.union([
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  z.object({ type: z.string() }),
])
type InputItemT = z.infer<typeof InputItem>

// Flat OpenAI Responses tool definitions. Function tools carry a string name +
// JSON Schema `parameters`; other tool types are skipped (no `function` type).
const ToolDef = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
})

const ResponsesBody = z.object({
  model: z.string().min(1),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  reasoning: z.object({ effort: z.string().optional() }).optional(),
  tools: z.array(ToolDef).optional(),
  input: z.array(InputItem),
})

const isMessageItem = (i: InputItemT): i is z.infer<typeof MessageItem> =>
  i.type === "message"
const isFunctionCallItem = (
  i: InputItemT,
): i is z.infer<typeof FunctionCallItem> => i.type === "function_call"
const isFunctionCallOutputItem = (
  i: InputItemT,
): i is z.infer<typeof FunctionCallOutputItem> =>
  i.type === "function_call_output"

const isTextBlock = (
  b: MessageContentBlockT,
): b is z.infer<typeof InputTextBlock> | z.infer<typeof OutputTextBlock> =>
  b.type === "input_text" || b.type === "output_text"

// Concatenate the text of a message content value, ignoring non-text parts.
const flatten = (c: z.infer<typeof MessageContent>): string =>
  typeof c === "string"
    ? c
    : c
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")

// Stringify a function_call_output's output (string passes through; an object
// or other JSON value is JSON-serialized).
const flattenOutput = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output)

// Parse a function_call's `arguments` JSON string, falling back to {} when it
// is malformed (the relay must not throw on bad harness input).
const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// Map function tools, skipping non-function entries and entries without a
// string name; default a missing `parameters` to an empty object schema.
const mapTools = (
  tools: z.infer<typeof ToolDef>[] | undefined,
): NormalizedTool[] => {
  if (tools === undefined) return []
  const mapped: NormalizedTool[] = []
  for (const t of tools) {
    if (t.type !== "function" || typeof t.name !== "string") continue
    mapped.push({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.parameters ?? { type: "object" },
    })
  }
  return mapped
}

export const parseResponsesRequest = (
  body: unknown,
): Result<NormalizedRequest, ProxyError> => {
  const parsed = ResponsesBody.safeParse(body)
  if (!parsed.success)
    return err({ kind: "bad-request", detail: parsed.error.message })
  const b = parsed.data

  // Collect system text: top-level instructions first, then any folded
  // developer/system message items, joined with newlines.
  const systemPieces: string[] = [
    ...(b.instructions !== undefined ? [b.instructions] : []),
    ...b.input
      .filter(isMessageItem)
      .filter((m) => m.role === "developer" || m.role === "system")
      .map((m) => flatten(m.content)),
  ]
  const system = systemPieces.join("\n") || undefined

  // Resolve tool names for function_call_output items: Responses omits the
  // name there, so map each function_call's call_id → name in input order.
  const toolNameByCallId = new Map<string, string>()
  for (const item of b.input) {
    if (isFunctionCallItem(item)) toolNameByCallId.set(item.call_id, item.name)
  }

  // Build normalized messages in input order. function_call items collapse
  // into an assistant turn; consecutive ones accumulate into the same turn.
  const messages: NormalizedMessage[] = []
  let pendingToolCalls: NormalizedContentPart[] = []
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    messages.push({ role: "assistant", content: pendingToolCalls })
    pendingToolCalls = []
  }

  for (const item of b.input) {
    if (isFunctionCallItem(item)) {
      pendingToolCalls.push({
        type: "tool-call",
        toolCallId: item.call_id,
        toolName: item.name,
        input: parseArguments(item.arguments),
      })
      continue
    }
    flushToolCalls()

    if (isFunctionCallOutputItem(item)) {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: item.call_id,
            toolName: toolNameByCallId.get(item.call_id) ?? "tool",
            output: flattenOutput(item.output),
          },
        ],
      })
      continue
    }

    if (isMessageItem(item)) {
      if (item.role === "developer" || item.role === "system") continue
      messages.push({ role: item.role, content: flatten(item.content) })
    }
    // Unknown item types (e.g. reasoning) are ignored.
  }
  flushToolCalls()

  if (messages.length === 0)
    return err({ kind: "bad-request", detail: "no user/assistant messages" })

  const tools = mapTools(b.tools)

  return ok({
    model: b.model,
    ...(system !== undefined ? { system } : {}),
    ...(b.max_output_tokens !== undefined
      ? { maxTokens: b.max_output_tokens }
      : {}),
    ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...((): { thinkingEffort?: ThinkingEffort } => {
      const t = effortStringToTier(b.reasoning?.effort)
      return t !== undefined ? { thinkingEffort: t } : {}
    })(),
    stream: b.stream ?? false,
    messages,
  })
}
