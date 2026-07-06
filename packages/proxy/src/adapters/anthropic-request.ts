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

// A text block. Anthropic blocks may carry extra keys (e.g. cache_control);
// the non-strict object tolerates and ignores them. Non-text blocks
// (tool_use/tool_result/image/document) are matched by their own branches below.
const TextBlock = z.object({ type: z.literal("text"), text: z.string() })

// Base64 image/document source (Anthropic's only attachment source shape we accept).
const Base64Source = z.object({
  type: z.literal("base64"),
  media_type: z.string().min(1),
  data: z.string(),
})

// User-attached image. Decoded at this boundary (base64 → bytes) so the gateway can hand the
// raw Uint8Array to the AI SDK streamText call.
const ImageBlock = z.object({ type: z.literal("image"), source: Base64Source })

// User-attached document (PDF is the supported kind). Same decode-at-boundary rule as image.
const DocumentBlock = z.object({
  type: z.literal("document"),
  source: Base64Source,
})

// An assistant tool call. `input` is arbitrary JSON; keep it as unknown.
const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

// A tool result fed back by the harness. Anthropic omits the tool name here (only tool_use_id is
// present); content is a string OR an array of blocks. We accept ANY block shape (not just text) so
// a multimodal tool result — e.g. one carrying an image block — still parses as a tool_result rather
// than falling through to the generic catch-all (which would drop tool_use_id and orphan the call).
const ToolResultContentBlock = z.object({
  type: z.string(),
  text: z.string().optional(),
})
const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(ToolResultContentBlock)]),
})

const ContentBlock = z.union([
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  DocumentBlock,
  z.object({ type: z.string() }),
])
type ContentBlockT = z.infer<typeof ContentBlock>
const Content = z.union([z.string(), z.array(ContentBlock)])

// system: a string, or an array of text blocks (Claude Code sends the latter).
const System = z.union([z.string(), z.array(TextBlock)])

// Top-level tool definitions. Custom tools carry a string name + JSON Schema;
// server tools are shaped differently and are skipped (no string name).
const ToolDef = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
})

const AnthropicBody = z.object({
  model: z.string().min(1),
  system: System.optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  tools: z.array(ToolDef).optional(),
  thinking: z
    .object({
      type: z.string(),
      budget_tokens: z.number().int().positive().optional(),
    })
    .optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: Content,
      }),
    )
    .min(1),
})

const isTextBlock = (b: ContentBlockT): b is z.infer<typeof TextBlock> =>
  b.type === "text"
const isToolUseBlock = (b: ContentBlockT): b is z.infer<typeof ToolUseBlock> =>
  b.type === "tool_use"
const isToolResultBlock = (
  b: ContentBlockT,
): b is z.infer<typeof ToolResultBlock> => b.type === "tool_result"
const isImageBlock = (b: ContentBlockT): b is z.infer<typeof ImageBlock> =>
  b.type === "image" && "source" in b
const isDocumentBlock = (
  b: ContentBlockT,
): b is z.infer<typeof DocumentBlock> => b.type === "document" && "source" in b

// Concatenate the text of a content value, ignoring non-text blocks.
const flatten = (c: z.infer<typeof Content>): string =>
  typeof c === "string"
    ? c
    : c
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")

// Flatten a system value (string or array of text blocks) to a string.
const flattenSystem = (s: z.infer<typeof System>): string =>
  typeof s === "string" ? s : s.map((b) => b.text).join("")

// Extract the text of a tool_result's content (string passes through; an array concatenates the
// text of its text blocks, ignoring non-text blocks such as images).
const flattenToolResult = (
  c: z.infer<typeof ToolResultBlock>["content"],
): string =>
  typeof c === "string"
    ? c
    : c
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")

// Map top-level tool definitions, skipping entries without a string name and
// defaulting a missing input_schema to an empty object schema.
const mapTools = (
  tools: z.infer<typeof ToolDef>[] | undefined,
): NormalizedTool[] => {
  if (tools === undefined) return []
  const mapped: NormalizedTool[] = []
  for (const t of tools) {
    if (typeof t.name !== "string") continue
    mapped.push({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.input_schema ?? { type: "object" },
    })
  }
  return mapped
}

// Map an inbound Anthropic thinking block back to a canonical tier. budget_tokens buckets
// mirror the driver's tier→budget mapping; an adaptive block with no budget defaults to medium.
const thinkingToTier = (
  t: { type: string; budget_tokens?: number | undefined } | undefined,
): ThinkingEffort | undefined => {
  if (t === undefined) return undefined
  if (t.type !== "enabled" && t.type !== "adaptive") return undefined
  const b = t.budget_tokens
  if (b === undefined) return "medium"
  if (b <= 1024) return "minimal"
  if (b <= 4096) return "low"
  if (b <= 8192) return "medium"
  if (b <= 16384) return "high"
  return "max"
}

export const parseAnthropicRequest = (
  body: unknown,
): Result<NormalizedRequest, ProxyError> => {
  const parsed = AnthropicBody.safeParse(body)
  if (!parsed.success)
    return err({ kind: "bad-request", detail: parsed.error.message })
  const b = parsed.data

  // Collect system text: top-level system first, then any folded
  // system-role messages, joined with newlines.
  const systemPieces: string[] = [
    ...(b.system !== undefined ? [flattenSystem(b.system)] : []),
    ...b.messages
      .filter((m) => m.role === "system")
      .map((m) => flatten(m.content)),
  ]
  const system = systemPieces.join("\n") || undefined

  // Resolve tool names for tool_result blocks: Anthropic omits the name on a
  // tool_result, so map each tool_use id → name by scanning assistant turns.
  const toolNameById = new Map<string, string>()
  for (const m of b.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue
    for (const block of m.content) {
      if (isToolUseBlock(block)) toolNameById.set(block.id, block.name)
    }
  }

  // Build normalized messages, preserving conversation order. A single
  // Anthropic user turn may expand into a user-text message and/or a tool-role
  // message; an assistant turn with tool_use becomes structured parts.
  const messages: NormalizedMessage[] = []
  for (const m of b.messages) {
    if (m.role === "system") continue

    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        messages.push({ role: "assistant", content: m.content })
        continue
      }
      const hasToolUse = m.content.some(isToolUseBlock)
      if (!hasToolUse) {
        // Text-only assistant: keep the existing flattened-string behavior.
        messages.push({ role: "assistant", content: flatten(m.content) })
        continue
      }
      const parts: NormalizedContentPart[] = []
      for (const block of m.content) {
        if (isTextBlock(block)) parts.push({ type: "text", text: block.text })
        else if (isToolUseBlock(block))
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          })
      }
      messages.push({ role: "assistant", content: parts })
      continue
    }

    // role === "user"
    if (typeof m.content === "string") {
      messages.push({ role: "user", content: m.content })
      continue
    }
    const toolResults = m.content.filter(isToolResultBlock)
    if (toolResults.length === 0) {
      // Attachment turn: when the user message carries image/document blocks, build parts in the
      // original block order (text + image/file). Base64 is decoded HERE — the transport encoding
      // stops at this boundary. Text-only turns keep the existing flattened-string shape.
      const media = m.content.filter(
        (b) => isImageBlock(b) || isDocumentBlock(b),
      )
      if (media.length === 0) {
        messages.push({ role: "user", content: flatten(m.content) })
        continue
      }
      const parts: NormalizedContentPart[] = []
      for (const block of m.content) {
        if (isTextBlock(block)) {
          parts.push({ type: "text", text: block.text })
        } else if (isImageBlock(block)) {
          // Re-wrap through Uint8Array.from so the data crosses the adapter boundary as
          // Uint8Array<ArrayBuffer> (the zod schema's narrowing), not the wider
          // Uint8Array<ArrayBufferLike> that Buffer.from returns.
          const decoded = Buffer.from(block.source.data, "base64")
          const data = new Uint8Array(decoded.byteLength)
          data.set(decoded)
          parts.push({
            type: "image",
            data,
            mediaType: block.source.media_type,
          })
        } else if (isDocumentBlock(block)) {
          const decoded = Buffer.from(block.source.data, "base64")
          const data = new Uint8Array(decoded.byteLength)
          data.set(decoded)
          parts.push({
            type: "file",
            data,
            mediaType: block.source.media_type,
          })
        }
        // Other block types are ignored, as before.
      }
      messages.push({ role: "user", content: parts })
      continue
    }
    // Mixed turn: the tool results MUST come first — directly after the assistant tool_use — so the
    // AI SDK can pair each tool call with its result. An intervening user message (e.g. a same-turn
    // <system-reminder> text block, which Claude Code routinely sends) orphans the tool call and
    // triggers AI_MissingToolResultsError. Any such text follows as its own user message.
    const parts: NormalizedContentPart[] = toolResults.map((block) => ({
      type: "tool-result",
      toolCallId: block.tool_use_id,
      toolName: toolNameById.get(block.tool_use_id) ?? "tool",
      output: flattenToolResult(block.content),
    }))
    messages.push({ role: "tool", content: parts })
    const text = flatten(m.content)
    if (text.length > 0) messages.push({ role: "user", content: text })
  }

  if (messages.length === 0)
    return err({ kind: "bad-request", detail: "no user/assistant messages" })

  const tools = mapTools(b.tools)

  return ok({
    model: b.model,
    ...(system !== undefined ? { system } : {}),
    ...(b.max_tokens !== undefined ? { maxTokens: b.max_tokens } : {}),
    ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
    ...((): { thinkingEffort?: ThinkingEffort } => {
      const tier = thinkingToTier(b.thinking)
      return tier !== undefined ? { thinkingEffort: tier } : {}
    })(),
    ...(tools.length > 0 ? { tools } : {}),
    stream: b.stream ?? false,
    messages,
  })
}
