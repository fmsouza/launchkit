import { RunnerIdSchema, SessionIdSchema } from "@spectrum/types"
import { z } from "zod"
import { AttachmentCapabilitiesSchema, AttachmentRefSchema } from "./attachment"
import { ThinkingEffortSchema } from "./thinking-effort"

export type Json = unknown

export const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict()
export type Usage = z.infer<typeof UsageSchema>

export const ApprovalTargetSchema = z
  .object({
    kind: z.enum(["command", "file", "tool"]),
    detail: z.string(),
  })
  .strict()
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>

export const ApprovalDecisionSchema = z.enum(["allow", "deny", "allow-always"])
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

export const QuestionOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict()
export type QuestionOption = z.infer<typeof QuestionOptionSchema>

export const QuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(QuestionOptionSchema),
    multiSelect: z.boolean(),
    allowFreeText: z.boolean(),
  })
  .strict()
export type Question = z.infer<typeof QuestionSchema>

export const QuestionPromptSchema = z
  .object({ questions: z.array(QuestionSchema).min(1) })
  .strict()
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>

export const QuestionSelectionSchema = z
  .object({
    questionIndex: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    freeText: z.string().optional(),
  })
  .strict()
export type QuestionSelection = z.infer<typeof QuestionSelectionSchema>

export const QuestionAnswerSchema = z
  .object({ selections: z.array(QuestionSelectionSchema) })
  .strict()
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>

export const PermissionModeSchema = z.enum([
  "manual",
  "auto-edits",
  "plan",
  "bypass",
])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

export const CanonicalEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("runner-started"),
      runnerId: RunnerIdSchema,
      parentRunnerId: RunnerIdSchema.optional(),
      spawnedByCallId: z.string().optional(),
      agentType: z.string().optional(),
      title: z.string().optional(),
      model: z.string().optional(),
      thinkingEffort: ThinkingEffortSchema.optional(),
      supportedModes: z.array(PermissionModeSchema).optional(),
      supportedAttachments: AttachmentCapabilitiesSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("runner-finished"),
      runnerId: RunnerIdSchema,
      status: z.enum(["completed", "errored", "interrupted"]),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn-finished"),
      runnerId: RunnerIdSchema,
      usage: UsageSchema.optional(),
      // A TURN-level failure (e.g. the provider rate-limited the request): the turn is over but the
      // session stays alive for a retry — distinct from runner-finished:"errored" (runner is dead).
      // `messageId` references the already-streamed message carrying the error text, so the view can
      // render that bubble in its error state instead of duplicating the text.
      error: z
        .object({
          detail: z.string(),
          messageId: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("text-delta"),
      runnerId: RunnerIdSchema,
      messageId: z.string(),
      text: z.string(),
      // Who authored the message. Defaults to "assistant" (harness output). The runtime stamps
      // "user" on the turns the user sends, so they render as their own bubbles in the timeline.
      role: z.enum(["user", "assistant"]).optional(),
      // Correlation id minted by the renderer on submit and persisted in its durable outbox before
      // dispatch. Echoed back here so the renderer can deterministically reconcile the optimistic
      // "sending" bubble against the landed message. Only meaningful for role:"user".
      clientSendId: z.string().optional(),
      // Refs (no bytes) for attachments on this user turn. Stripped of dataUrl by the runtime
      // before emit so the persisted log stays small and pure.
      attachments: z.array(AttachmentRefSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning-delta"),
      runnerId: RunnerIdSchema,
      messageId: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool-call-started"),
      runnerId: RunnerIdSchema,
      callId: z.string(),
      tool: z.string(),
      input: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool-output-delta"),
      runnerId: RunnerIdSchema,
      callId: z.string(),
      chunk: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool-call-finished"),
      runnerId: RunnerIdSchema,
      callId: z.string(),
      status: z.enum(["ok", "error"]),
      output: z.string().optional(),
      exitCode: z.number().int().optional(),
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("file-change"),
      runnerId: RunnerIdSchema,
      callId: z.string().optional(),
      path: z.string(),
      kind: z.enum(["add", "update", "delete"]),
      diff: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval-requested"),
      runnerId: RunnerIdSchema,
      requestId: z.string(),
      target: ApprovalTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval-resolved"),
      runnerId: RunnerIdSchema,
      requestId: z.string(),
      decision: ApprovalDecisionSchema,
      by: z.enum(["user", "policy"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("question-requested"),
      runnerId: RunnerIdSchema,
      requestId: z.string(),
      prompt: QuestionPromptSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("question-resolved"),
      runnerId: RunnerIdSchema,
      requestId: z.string(),
      answer: QuestionAnswerSchema,
      by: z.literal("user"),
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      runnerId: RunnerIdSchema,
      usage: UsageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("annotation"),
      runnerId: RunnerIdSchema,
      kind: z.string(),
      data: z.unknown(),
    })
    .strict(),
])
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>

export const StoredEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    sessionId: SessionIdSchema,
    ts: z.string().datetime(),
    event: CanonicalEventSchema,
  })
  .strict()
export type StoredEvent = z.infer<typeof StoredEventSchema>
