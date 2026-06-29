import type { RunnerId } from "@spectrum/agent-events"
import type {
  ApprovalDecision,
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type { HarnessId, ModelId, SessionId } from "@spectrum/types"
import type { Result } from "@spectrum/utils"

export type DriverError = {
  readonly kind:
    | "start-failed"
    | "send-failed"
    | "not-running"
    | "driver-internal"
  readonly detail: string
}

export interface AgentStartInput {
  readonly harnessId: HarnessId
  readonly modelId?: ModelId
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly initialPrompt?: string
  /**
   * The harness-resolved absolute executable (e.g. the `claude` binary). A driver that spawns its
   * harness via an SDK needs this because the SDK's own bundle-relative executable resolution breaks
   * once the app is bundled (no node_modules / cli.js in the packaged binary). Sourced from the same
   * `CommandResolver` the terminal path uses, so there is one source of truth for "where is claude".
   */
  readonly command?: string
  /**
   * The harness-resolved launch args (the same the terminal path spawns with). A driver whose proxy
   * routing lives in CLI args rather than env needs these — e.g. codex routes only through a provider
   * declared via `-c model_providers.spectrum.*` overrides; without them a native codex session
   * ignores the Spectrum proxy. Drivers that route via env (claude/opencode/openclaw) ignore this.
   */
  readonly args?: readonly string[]
  /** The normalized permission mode the session starts in; absent = "manual". */
  readonly permissionMode?: PermissionMode
  /** The thinking-effort tier the session starts at; absent = the harness default. */
  readonly thinkingEffort?: ThinkingEffort
  /**
   * The harness-native session id to resume (e.g. Claude's session_id, Codex's threadId).
   * Absent = a fresh harness session; present = resume the exact prior conversation.
   * Drivers that can't resume (OpenCode/OpenClaw) ignore this and start fresh.
   */
  readonly resume?: string
  /**
   * The Spectrum `SessionId` for this run. Drivers that need to bind a callback (e.g.
   * `reportResumeToken`) to the originating Spectrum session use this to look it up.
   */
  readonly sessionId?: SessionId
}

export interface AgentSession {
  readonly rootRunnerId: RunnerId
  onEvent(cb: (e: CanonicalEvent) => void): void
  send(turn: {
    readonly text: string
    readonly clientSendId?: string
  }): Result<void, DriverError>
  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Result<void, DriverError>
  respondQuestion(
    requestId: string,
    answer: QuestionAnswer,
  ): Result<void, DriverError>
  interrupt(): Result<void, DriverError>
  close(): Result<void, DriverError>
  /** Switch the normalized permission mode mid-session (driver applies natively or on next turn). */
  setMode?(mode: PermissionMode): Result<void, DriverError>
  /** Switch the model mid-session; an optional env re-renders the route (direct↔proxied). null clears the model (back to harness default / subscription). */
  setModel?(
    modelId: ModelId | null,
    env?: Readonly<Record<string, string>>,
  ): Result<void, DriverError>
  /** Switch the thinking-effort tier mid-session (driver applies natively or on next turn). */
  setThinkingEffort?(effort: ThinkingEffort): Result<void, DriverError>
}

export interface AgentDriver {
  start(input: AgentStartInput): Result<AgentSession, DriverError>
}
