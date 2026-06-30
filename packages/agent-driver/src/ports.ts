import type { CanonicalEvent, StoredEvent } from "@spectrum/agent-events"
import type { HarnessId, ModelId, Session, SessionId } from "@spectrum/types"
import type { Result } from "@spectrum/utils"

/** Subset of SessionStore the RunManager needs (defined locally to avoid a sessions dependency). */
export interface SessionSink {
  create(input: {
    harnessId: HarnessId
    modelId?: ModelId
    name?: string
    cwd?: string
  }): Result<Session, { kind: string; detail?: string }>
  close(
    id: SessionId,
    exitCode: number,
  ): Result<Session, { kind: string; detail?: string }>
  /** Write back a derived/harness session name (auto-naming + manual rename). */
  updateName(
    id: SessionId,
    name: string,
  ): Result<Session, { kind: string; detail?: string }>
  /** Persist the harness's resume id (driver session id) so we can resume later. */
  setResumeId(
    id: SessionId,
    resumeId: string,
  ): Result<Session, { kind: string; detail?: string }>
  /** Mark a previously-closed session as open again for a resumed run. */
  reopen(id: SessionId): Result<Session, { kind: string; detail?: string }>
  /** Look up a session by id (returns undefined if not found). */
  get(
    id: SessionId,
  ): Result<Session | undefined, { kind: string; detail?: string }>
}

/** Subset of RunStore the RunManager needs (defined locally to avoid a run-store dependency). */
export interface RunEventSink {
  append(
    sessionId: SessionId,
    event: CanonicalEvent,
  ): Result<{ seq: number }, { detail: string }>
  read(sessionId: SessionId): Result<readonly StoredEvent[], { detail: string }>
}

/** Error from the injected name generator (kept structural so the manager stays proxy-free). */
export type NameGenError =
  | { readonly kind: "no-model-selected" }
  | { readonly kind: "route-not-found" }
  | { readonly kind: "provider-not-found" }
  | { readonly kind: "model-unavailable"; readonly detail?: string }
  | { readonly kind: "generation-failed"; readonly detail?: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "aborted" }

/** Optional one-shot AI session-name generator, injected by the composition root. */
export interface NameGeneratorPort {
  generate(
    modelId: ModelId,
    firstPrompt: string,
    signal: AbortSignal,
  ): Promise<Result<string, NameGenError>>
}
