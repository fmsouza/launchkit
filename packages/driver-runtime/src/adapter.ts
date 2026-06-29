import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  QuestionPrompt,
  RunnerId,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type { ModelId } from "@spectrum/types"

/** A live, mapped handle to a started harness. Methods are fire-and-forget (errors surface as events). */
export interface AdapterHandle {
  /** A follow-up user turn. */
  send(text: string): void
  /** Stop the current turn (top-level). */
  interrupt(): void
  /** Terminate the process / disconnect the server (idempotent). */
  close(): void
  /** Switch the normalized permission mode (apply natively now, or stash for the next turn). */
  setMode?(mode: PermissionMode): void
  /** Switch the model (apply natively now, resume-restart, or fresh session). null = clear the model (back to harness default). */
  setModel?(
    modelId: ModelId | null,
    env?: Readonly<Record<string, string>>,
  ): void
  /** Switch the thinking-effort tier (apply natively now, or stash for the next turn). */
  setThinkingEffort?(effort: ThinkingEffort): void
}

/** What the runtime gives the adapter: a push channel + the approval bridge + runner-id minting. */
export interface AdapterCtx {
  /** Push a mapped canonical event into the run's stream (persisted + forwarded by the RunManager). */
  emit(event: CanonicalEvent): void
  /** Emit `approval-requested` and resolve when the user answers (`run-approve` → respondApproval). */
  requestApproval(
    runnerId: RunnerId,
    target: ApprovalTarget,
  ): Promise<ApprovalDecision>
  /** Emit `question-requested` and resolve when the user answers (`run-answer` → respondQuestion). */
  requestQuestion(
    runnerId: RunnerId,
    prompt: QuestionPrompt,
  ): Promise<QuestionAnswer>
  /** Mint a fresh RunnerId (the root is minted by the runtime and exposed as `rootRunnerId`). */
  newRunnerId(): RunnerId
  /** The root runner id (already minted by the runtime before `start` is called). */
  readonly rootRunnerId: RunnerId
  /**
   * Report the harness-native session id (e.g. Claude's session_id, Codex's threadId) once the
   * adapter learns it, so the manager can persist it on the originating Spectrum session for
   * later resume. Placed on ctx only when the runtime knows the Spectrum `sessionId` AND the
   * caller wired a `setResumeId` sink; adapters that don't resume should ignore the absence.
   */
  reportResumeToken?(resumeToken: string): void
}

/** One per harness. `start` does the real async spawn/connect and returns a live handle. */
export interface DriverAdapter {
  start(input: AgentStartInput, ctx: AdapterCtx): Promise<AdapterHandle>
  /** The normalized modes this harness supports; omitted = manual only. */
  readonly supportedModes?: readonly PermissionMode[]
}
