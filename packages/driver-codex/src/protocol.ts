import type { AttachmentRefWithBytes } from "@spectrum/agent-events"
import type { ServerNotification } from "./bindings/ServerNotification"
import type { ServerRequest } from "./bindings/ServerRequest"
import type { CommandExecutionApprovalDecision } from "./bindings/v2/CommandExecutionApprovalDecision"
import type { CommandExecutionRequestApprovalParams } from "./bindings/v2/CommandExecutionRequestApprovalParams"
import type { FileChangeApprovalDecision } from "./bindings/v2/FileChangeApprovalDecision"
import type { FileChangeRequestApprovalParams } from "./bindings/v2/FileChangeRequestApprovalParams"
import type { ThreadItem } from "./bindings/v2/ThreadItem"
import type { ThreadStartResponse } from "./bindings/v2/ThreadStartResponse"
import type { ThreadTokenUsage } from "./bindings/v2/ThreadTokenUsage"
import type { Turn } from "./bindings/v2/Turn"
import type { TurnStatus } from "./bindings/v2/TurnStatus"

// Server→client notification method strings (single source of truth for the mapper + transport dispatch).
export const THREAD_STARTED = "thread/started" as const
export const TURN_STARTED = "turn/started" as const
export const TURN_COMPLETED = "turn/completed" as const
export const ITEM_STARTED = "item/started" as const
export const ITEM_COMPLETED = "item/completed" as const
export const AGENT_MESSAGE_DELTA = "item/agentMessage/delta" as const
export const REASONING_TEXT_DELTA = "item/reasoning/textDelta" as const
export const REASONING_SUMMARY_DELTA =
  "item/reasoning/summaryTextDelta" as const
export const COMMAND_OUTPUT_DELTA = "item/commandExecution/outputDelta" as const
export const TOKEN_USAGE_UPDATED = "thread/tokenUsage/updated" as const
export const ERROR_NOTIFICATION = "error" as const

// Server→client approval REQUEST method strings.
export const REQ_COMMAND_APPROVAL =
  "item/commandExecution/requestApproval" as const
export const REQ_FILECHANGE_APPROVAL =
  "item/fileChange/requestApproval" as const
export const REQ_USER_INPUT = "item/tool/requestUserInput" as const
export const REQ_ELICITATION = "mcpServer/elicitation/request" as const

// Client→server method strings used by the transport/adapter.
export const M_INITIALIZE = "initialize" as const
export const M_INITIALIZED = "initialized" as const
export const M_THREAD_START = "thread/start" as const
export const M_THREAD_RESUME = "thread/resume" as const
export const M_TURN_START = "turn/start" as const
export const M_TURN_STEER = "turn/steer" as const
export const M_TURN_INTERRUPT = "turn/interrupt" as const

// Re-exported generated union types the mapper/adapter consume (no `any`).
export type CodexServerNotification = ServerNotification
export type CodexServerRequest = ServerRequest
export type CodexThreadItem = ThreadItem
export type CodexTurn = Turn
export type CodexTurnStatus = TurnStatus
export type CodexThreadTokenUsage = ThreadTokenUsage
export type CodexThreadStartResponse = ThreadStartResponse
export type CodexCommandApprovalParams = CommandExecutionRequestApprovalParams
export type CodexFileChangeApprovalParams = FileChangeRequestApprovalParams
export type CodexCommandApprovalDecision = CommandExecutionApprovalDecision
export type CodexFileChangeApprovalDecision = FileChangeApprovalDecision

/** Narrow text-turn helper for `turn/start` + `turn/steer` (the `UserInput` "text" arm). */
export const textInput = (
  text: string,
): { type: "text"; text: string; text_elements: [] } => ({
  type: "text",
  text,
  text_elements: [],
})

/**
 * Build a Codex `UserInput` image arm from a send-path attachment.
 *
 * TODO(manual-smoke): the `codex app-server` v2 image arm MAY reject `data:`
 * URLs at runtime (no unit-test coverage — the test transport is fake). When
 * we next run a Codex session in a real GUI build, attach an image and confirm
 * the driver accepts the `data:image/...;base64,...` URL end-to-end. If the
 * server rejects it, the fix will be to upload bytes to a temporary file and
 * pass a `file://` URL (or whatever the app-server v2 actually accepts).
 */
export const imageInput = (
  ref: AttachmentRefWithBytes,
): { type: "image"; url: string } => ({
  type: "image",
  url: ref.dataUrl,
})
