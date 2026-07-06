import { ThinkingEffortSchema } from "@spectrum/agent-events"
import { z } from "zod"

/**
 * A tool the model may call. The proxy is a RELAY: it forwards tool definitions to the model and
 * streams tool calls back to the harness, but never executes a tool itself (the harness does). So a
 * tool carries only its definition — name, optional description, and a JSON Schema for its input.
 */
export const NormalizedToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.unknown(),
  })
  .strict()
export type NormalizedTool = z.infer<typeof NormalizedToolSchema>

/**
 * A piece of message content. Plain text, an attached image/file, an assistant tool call, or a
 * tool result. Image/file parts carry the raw bytes decoded at the inbound adapter boundary so
 * the gateway can hand them straight to the AI SDK `streamText` call.
 */
export const NormalizedContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    data: z.instanceof(Uint8Array),
    mediaType: z.string().min(1),
  }),
  z.object({
    type: z.literal("file"),
    data: z.instanceof(Uint8Array),
    mediaType: z.string().min(1),
    filename: z.string().min(1).optional(),
  }),
])
export type NormalizedContentPart = z.infer<typeof NormalizedContentPartSchema>

/**
 * A conversation message. `content` is either a plain string (the common text case) or an array of
 * structured parts (used to carry assistant tool calls and tool results). Role `"tool"` carries
 * tool-result parts (the AI SDK models tool output as its own message role).
 */
export const NormalizedMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(NormalizedContentPartSchema)]),
  })
  .strict()
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>

export const NormalizedRequestSchema = z
  .object({
    model: z.string().min(1),
    system: z.string().optional(),
    messages: z.array(NormalizedMessageSchema).min(1),
    tools: z.array(NormalizedToolSchema).optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    thinkingEffort: ThinkingEffortSchema.optional(),
    stream: z.boolean(),
  })
  .strict()
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>

/**
 * Provider-agnostic stream events the gateway yields and the outbound serializers render. A
 * `tool-call` carries the COMPLETE call (the gateway maps the AI SDK high-level `tool-call` part,
 * which already has the fully-assembled `input`); the serializer renders it as one tool_use block.
 */
export type StreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-call"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly type: "finish"
      readonly finishReason: string
      readonly usage?: {
        readonly inputTokens: number
        readonly outputTokens: number
      }
    }
  | {
      readonly type: "error"
      readonly detail: string
      /** The upstream provider's HTTP status, when the failure was an HTTP error (e.g. 429). */
      readonly statusCode?: number
    }

export type ProxyError =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad-request"; readonly detail: string }
  | { readonly kind: "unknown-model"; readonly id: string }
  | { readonly kind: "unknown-provider"; readonly providerId: string }
  | { readonly kind: "unsupported-provider"; readonly sdkProvider: string }
  | {
      readonly kind: "provider-failed"
      readonly detail: string
      /** The upstream provider's HTTP status, when the failure was an HTTP error (e.g. 429). */
      readonly statusCode?: number
    }
  | {
      readonly kind: "unsupported-model-discovery"
      readonly sdkProvider: string
    }
