import {
  ApprovalDecisionSchema,
  PermissionModeSchema,
  QuestionAnswerSchema,
  ThinkingEffortSchema,
} from "@spectrum/agent-events"
import type {
  ApprovalDecision,
  PermissionMode,
  QuestionAnswer,
  StoredEvent,
  ThinkingEffort,
} from "@spectrum/agent-events"
import {
  type ModelId,
  ModelIdSchema,
  type SessionId,
  SessionIdSchema,
} from "@spectrum/types"

import { type Result, err, ok } from "@spectrum/utils"
import { z } from "zod"

export type RunnerOutbound =
  | {
      readonly type: "runner-event"
      readonly id: SessionId
      readonly event: StoredEvent
    }
  | {
      readonly type: "session-renamed"
      readonly id: SessionId
      readonly name: string
    }
  | {
      readonly type: "session-resume-token"
      readonly id: SessionId
      readonly resumeToken: string
    }

export type RunnerInbound =
  | { readonly type: "run-attach"; readonly id: SessionId }
  | {
      readonly type: "run-send"
      readonly id: SessionId
      readonly text: string
      readonly clientSendId?: string | undefined
    }
  | {
      readonly type: "run-approve"
      readonly id: SessionId
      readonly requestId: string
      readonly decision: ApprovalDecision
    }
  | {
      readonly type: "run-answer"
      readonly id: SessionId
      readonly requestId: string
      readonly answer: QuestionAnswer
    }
  | { readonly type: "run-interrupt"; readonly id: SessionId }
  | {
      readonly type: "run-set-mode"
      readonly id: SessionId
      readonly mode: PermissionMode
    }
  | {
      readonly type: "run-set-model"
      readonly id: SessionId
      readonly modelId: ModelId | null
    }
  | {
      readonly type: "run-set-thinking-effort"
      readonly id: SessionId
      readonly effort: ThinkingEffort
    }

const InboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-attach"), id: SessionIdSchema }),
  z.object({
    type: z.literal("run-send"),
    id: SessionIdSchema,
    text: z.string(),
    clientSendId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run-approve"),
    id: SessionIdSchema,
    requestId: z.string(),
    decision: ApprovalDecisionSchema,
  }),
  z.object({
    type: z.literal("run-answer"),
    id: SessionIdSchema,
    requestId: z.string(),
    answer: QuestionAnswerSchema,
  }),
  z.object({ type: z.literal("run-interrupt"), id: SessionIdSchema }),
  z.object({
    type: z.literal("run-set-mode"),
    id: SessionIdSchema,
    mode: PermissionModeSchema,
  }),
  z.object({
    type: z.literal("run-set-model"),
    id: SessionIdSchema,
    modelId: ModelIdSchema.nullable(),
  }),
  z.object({
    type: z.literal("run-set-thinking-effort"),
    id: SessionIdSchema,
    effort: ThinkingEffortSchema,
  }),
])

export const decodeRunnerInbound = (
  raw: unknown,
): Result<RunnerInbound, { kind: "bad-message" }> => {
  const parsed = InboundSchema.safeParse(raw)
  return parsed.success ? ok(parsed.data) : err({ kind: "bad-message" })
}
