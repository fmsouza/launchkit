import type { RunnerId } from "@spectrum/types"
import { z } from "zod"

// ─── ACP session/update "update" discriminated union (v1) ───────────────────
// Modeled from the ACP v1 spec (agentclientprotocol.com/protocol/v1). This is
// the subset the mapper reads; `.passthrough()` tolerates extra infra fields.

const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough()

const ToolKindSchema = z
  .enum([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "other",
  ])
  .optional()

const ToolCallStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
])

const PlanPrioritySchema = z.enum(["high", "medium", "low"]).optional()
const PlanStatusSchema = z.enum(["pending", "in_progress", "completed"])

const PlanEntryShape = z
  .object({
    content: z.string(),
    priority: PlanPrioritySchema,
    status: PlanStatusSchema,
  })
  .passthrough()

export const AcpSessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  // agent_message_chunk — streamed assistant text keyed by messageId.
  z
    .object({
      sessionUpdate: z.literal("agent_message_chunk"),
      messageId: z.string().optional(),
      content: TextContentSchema.optional(),
    })
    .passthrough(),

  // agent_thought_chunk — reasoning/thinking chunk keyed by messageId.
  z
    .object({
      sessionUpdate: z.literal("agent_thought_chunk"),
      messageId: z.string().optional(),
      content: TextContentSchema.optional(),
    })
    .passthrough(),

  // user_message_chunk — the agent echoing the user's own turn back. The runtime already echoed
  // it locally before handing the turn to the adapter, so mapping it would duplicate the bubble.
  z
    .object({ sessionUpdate: z.literal("user_message_chunk") })
    .passthrough(),

  // tool_call — a new tool call announced with a status (default pending).
  z
    .object({
      sessionUpdate: z.literal("tool_call"),
      toolCallId: z.string(),
      title: z.string().optional(),
      kind: ToolKindSchema,
      status: ToolCallStatusSchema.optional(),
      content: z.array(z.unknown()).optional(),
      rawInput: z.unknown().optional(),
      locations: z.array(z.unknown()).optional(),
    })
    .passthrough(),

  // tool_call_update — a status/content update for an existing tool call.
  z
    .object({
      sessionUpdate: z.literal("tool_call_update"),
      toolCallId: z.string(),
      status: ToolCallStatusSchema.optional(),
      content: z.array(z.unknown()).optional(),
      rawOutput: z.unknown().optional(),
    })
    .passthrough(),

  // plan — the agent's execution plan as a list of entries (full replace).
  z
    .object({
      sessionUpdate: z.literal("plan"),
      entries: z.array(PlanEntryShape).min(1),
    })
    .passthrough(),

  // plan_update — a revised plan. Same payload as `plan`; replaces the previous one.
  z
    .object({
      sessionUpdate: z.literal("plan_update"),
      entries: z.array(PlanEntryShape).min(1),
    })
    .passthrough(),

  // plan_removed — the agent dropped its plan. Spectrum keeps the last plan card; nothing to emit.
  z
    .object({ sessionUpdate: z.literal("plan_removed") })
    .passthrough(),

  // usage_update — current session context + cumulative cost.
  z
    .object({
      sessionUpdate: z.literal("usage_update"),
      used: z.number().int().nonnegative().nullable(),
      size: z.number().int().nonnegative().nullable(),
      cost: z
        .object({
          amount: z.number().nonnegative(),
          currency: z.string(),
        })
        .optional(),
    })
    .passthrough(),

  // current_mode_update — the agent changed its mode from its side (client->agent is set_mode).
  z
    .object({
      sessionUpdate: z.literal("current_mode_update"),
      currentModeId: z.string().optional(),
    })
    .passthrough(),

  // Deliberately ignored v1 kinds: no Spectrum surface renders them yet. Declared (rather than
  // left to the defensive default) so the union stays TOTAL over ACP v1 and a future kind is a
  // visible type error rather than a silent drop.
  z
    .object({ sessionUpdate: z.literal("available_commands_update") })
    .passthrough(),
  z.object({ sessionUpdate: z.literal("config_option_update") }).passthrough(),
  z.object({ sessionUpdate: z.literal("session_info_update") }).passthrough(),
])
export type AcpSessionUpdate = z.infer<typeof AcpSessionUpdateSchema>

// ─── AcpSessionUpdate envelope (the notification payload) ──────────────────
export const AcpSessionUpdateNotificationSchema = z
  .object({
    sessionId: z.string(),
    update: AcpSessionUpdateSchema,
  })
  .passthrough()
export type AcpSessionUpdateNotification = z.infer<
  typeof AcpSessionUpdateNotificationSchema
>

// ─── ACP session/prompt response (the stopReason) ───────────────────────────
export const AcpStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])
export type AcpStopReason = z.infer<typeof AcpStopReasonSchema>

// ─── ACP session/request_permission (server→client request) ───────────────
export const AcpPermissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.enum([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]),
  })
  .passthrough()
export type AcpPermissionOption = z.infer<typeof AcpPermissionOptionSchema>

export const AcpPermissionRequestSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z.object({ toolCallId: z.string() }).passthrough(),
    options: z.array(AcpPermissionOptionSchema),
  })
  .passthrough()
export type AcpPermissionRequest = z.infer<typeof AcpPermissionRequestSchema>

// ─── ACP elicitation/create (server→client request) ───────────────────────
export const AcpElicitationSchema = z
  .object({
    message: z.string(),
    // ACP elicitation carries a `requestedSchema` (JSON Schema) or a form.
    requestedSchema: z.unknown().optional(),
  })
  .passthrough()
export type AcpElicitation = z.infer<typeof AcpElicitationSchema>

// ─── The injected transport port (mirrors OpenclawConnect / OpencodeConnect) ─
export interface AcpClient {
  initialize(): Promise<void>
  sessionNew(): Promise<string>
  sessionLoad(sessionId: string): Promise<string>
  sessionPrompt(
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
  ): Promise<AcpStopReason>
  sessionCancel(sessionId: string): void
  sessionSetMode(sessionId: string, mode: string): void
  sessionClose(sessionId: string): void
  onSessionUpdate(cb: (notif: AcpSessionUpdateNotification) => void): () => void
  onPermissionRequest(cb: (req: AcpPermissionRequest) => void): () => void
  onElicitationCreate(
    cb: (req: {
      sessionId: string
      requestId: string | number
      elicitation: AcpElicitation
    }) => void,
  ): () => void
  close(): void
}

export type AcpPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string }
  | {
      readonly type: "resource"
      readonly resource: {
        readonly uri: string
        readonly text: string
        readonly mimeType?: string
      }
    }

export interface AcpConnection {
  readonly client: AcpClient
  close(): void
}

export interface AcpConnectConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type AcpConnect = (config: AcpConnectConfig) => Promise<AcpConnection>

// ─── AcpMapState (the pure mapper's correlation state) ──────────────────────
export interface AcpMapState {
  readonly rootRunnerId: RunnerId
  readonly newRunnerId: () => RunnerId
  /** Track tool calls that have already been "started" to avoid double-start on re-emitted updates. */
  readonly startedToolCalls: Set<string>
}
