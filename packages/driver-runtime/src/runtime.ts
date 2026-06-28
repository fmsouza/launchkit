import type {
  AgentDriver,
  AgentSession,
  AgentStartInput,
} from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  QuestionPrompt,
  RunnerId,
} from "@spectrum/agent-events"
import type { ModelId, SessionId } from "@spectrum/types"
import { type IdGen, type Result, ok } from "@spectrum/utils"
import type { AdapterCtx, AdapterHandle, DriverAdapter } from "./adapter"

/**
 * Wrap a per-harness adapter into the synchronous `AgentDriver` seam. `idGen` mints runner ids
 * (`rnr` prefix) and approval request ids (`apr` prefix). The async adapter `start` runs via
 * `scheduler` (defaults to `queueMicrotask`; tests pass `(fn) => fn()`); a startup failure surfaces
 * as a `runner-finished:"errored"` canonical event. The runtime is PURE of harness specifics.
 */
export const createDriver = (deps: {
  readonly adapter: DriverAdapter
  readonly idGen: IdGen
  readonly scheduler?: (fn: () => void) => void
  /**
   * Sink the runtime invokes whenever an adapter reports its harness-native session id via
   * `ctx.reportResumeToken(token)`. Bound to the current Spectrum `sessionId` by the runtime —
   * adapters should call `ctx.reportResumeToken?.("…")` rather than tracking the id themselves.
   */
  readonly setResumeId?: (sessionId: SessionId, resumeId: string) => void
}): AgentDriver => {
  const schedule =
    deps.scheduler ?? ((fn: () => void): void => queueMicrotask(fn))

  const start: AgentDriver["start"] = (
    input: AgentStartInput,
  ): Result<AgentSession, never> => {
    const rootRunnerId = deps.idGen.next("rnr") as RunnerId
    let cb: ((e: CanonicalEvent) => void) | null = null
    let handle: AdapterHandle | undefined
    let closed = false
    const pending = new Map<
      string,
      { runnerId: RunnerId; resolve: (d: ApprovalDecision) => void }
    >()
    const questions = new Map<
      string,
      { runnerId: RunnerId; resolve: (a: QuestionAnswer) => void }
    >()
    const queue: Array<(h: AdapterHandle) => void> = []

    const emit = (event: CanonicalEvent): void => {
      cb?.(event)
    }
    const runOrQueue = (fn: (h: AdapterHandle) => void): void => {
      if (handle !== undefined) fn(handle)
      else queue.push(fn)
    }

    const ctx: AdapterCtx = {
      rootRunnerId,
      emit,
      newRunnerId: () => deps.idGen.next("rnr") as RunnerId,
      requestApproval: (runnerId: RunnerId, target: ApprovalTarget) =>
        new Promise<ApprovalDecision>((resolve) => {
          const requestId = deps.idGen.next("apr")
          pending.set(requestId, { runnerId, resolve })
          emit({ type: "approval-requested", runnerId, requestId, target })
        }),
      requestQuestion: (runnerId: RunnerId, prompt: QuestionPrompt) =>
        new Promise<QuestionAnswer>((resolve) => {
          const requestId = deps.idGen.next("qst")
          questions.set(requestId, { runnerId, resolve })
          emit({ type: "question-requested", runnerId, requestId, prompt })
        }),
      ...(deps.setResumeId !== undefined && input.sessionId !== undefined
        ? {
            reportResumeToken: (resumeToken: string): void => {
              deps.setResumeId?.(input.sessionId as SessionId, resumeToken)
            },
          }
        : {}),
    }

    schedule(() => {
      // Mark the root runner started BEFORE the adapter runs. This (a) renders the native
      // conversation + composer immediately, so the user can send the first turn that a
      // streaming-input harness (e.g. claude) needs before it emits anything, and (b) makes any
      // startup failure visible: the `errored` event below now attaches to an existing runner
      // instead of being dropped by the reducer. The harness's own `runner-started` (e.g. from
      // claude's system/init) is a harmless re-emit — the reducer treats it idempotently.
      emit({
        type: "runner-started",
        runnerId: rootRunnerId,
        ...(deps.adapter.supportedModes !== undefined
          ? { supportedModes: [...deps.adapter.supportedModes] }
          : {}),
        ...(input.permissionMode !== undefined
          ? { permissionMode: input.permissionMode }
          : {}),
        ...(input.modelId !== undefined
          ? { model: String(input.modelId) }
          : {}),
      })
      deps.adapter.start(input, ctx).then(
        (h) => {
          if (closed) {
            h.close()
            return
          }
          handle = h
          for (const fn of queue.splice(0)) fn(h)
        },
        (err: unknown) => {
          emit({
            type: "runner-finished",
            runnerId: rootRunnerId,
            status: "errored",
            error: String(err),
          })
        },
      )
    })

    const session: AgentSession = {
      rootRunnerId,
      onEvent: (next) => {
        cb = next
      },
      send: (turn) => {
        // Echo the user's turn into the canonical log so it renders as their own message bubble
        // (harnesses don't report the user's input back uniformly). Persisted + forwarded like any event.
        emit({
          type: "text-delta",
          runnerId: rootRunnerId,
          messageId: deps.idGen.next("msg"),
          text: turn.text,
          role: "user",
          ...(turn.clientSendId !== undefined
            ? { clientSendId: turn.clientSendId }
            : {}),
        })
        runOrQueue((h) => h.send(turn.text))
        return ok(undefined)
      },
      respondApproval: (requestId, decision) => {
        const entry = pending.get(requestId)
        if (entry !== undefined) {
          pending.delete(requestId)
          emit({
            type: "approval-resolved",
            runnerId: entry.runnerId,
            requestId,
            decision,
            by: "user",
          })
          entry.resolve(decision)
        }
        return ok(undefined)
      },
      respondQuestion: (requestId, answer) => {
        const entry = questions.get(requestId)
        if (entry !== undefined) {
          questions.delete(requestId)
          emit({
            type: "question-resolved",
            runnerId: entry.runnerId,
            requestId,
            answer,
            by: "user",
          })
          entry.resolve(answer)
        }
        return ok(undefined)
      },
      interrupt: () => {
        runOrQueue((h) => h.interrupt())
        return ok(undefined)
      },
      setMode: (mode: PermissionMode) => {
        runOrQueue((h) => h.setMode?.(mode))
        return ok(undefined)
      },
      setModel: (
        modelId: ModelId | null,
        env?: Readonly<Record<string, string>>,
      ) => {
        runOrQueue((h) => h.setModel?.(modelId, env))
        return ok(undefined)
      },
      close: () => {
        if (!closed) {
          closed = true
          handle?.close()
          handle = undefined
          queue.length = 0
          pending.clear()
          questions.clear()
        }
        return ok(undefined)
      },
    }
    return ok(session)
  }

  return { start }
}
