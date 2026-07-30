import type { RunnerId } from "@spectrum/types"
import type { AttachmentCapabilities, AttachmentRef } from "./attachment"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  Json,
  PermissionMode,
  PlanEntry,
  QuestionAnswer,
  QuestionPrompt,
  Usage,
} from "./events"

export type RunnerStatus = "running" | "completed" | "errored" | "interrupted"

export type MessageItem = {
  kind: "message"
  messageId: string
  role: "user" | "assistant"
  text: string
  /** Set when this message carries a turn error (e.g. a provider failure) — render in error state. */
  tone?: "error"
  /** Correlation id from the originating `run-send`; lets the renderer reconcile its outbox entry. */
  clientSendId?: string
  /** Attachments on this user turn (refs only — no bytes). */
  attachments?: readonly AttachmentRef[]
}
export type ReasoningItem = {
  kind: "reasoning"
  messageId: string
  text: string
}
export type ToolCallItem = {
  kind: "tool-call"
  callId: string
  tool: string
  input?: Json
  status: "running" | "ok" | "error"
  output?: string
  exitCode?: number
  result?: Json
  spawnedRunnerId?: RunnerId
}
export type FileChangeItem = {
  kind: "file-change"
  callId?: string
  path: string
  changeKind: "add" | "update" | "delete"
  diff?: string
}
export type ApprovalItem = {
  kind: "approval"
  requestId: string
  target: ApprovalTarget
  decision?: ApprovalDecision
  by?: "user" | "policy"
}
export type QuestionItem = {
  kind: "question"
  requestId: string
  prompt: QuestionPrompt
  answer?: QuestionAnswer
}
export type { PlanEntry } from "./events"
export type PlanItem = {
  kind: "plan"
  planId: string
  // `readonly` so re-emits replace cleanly; entries are snapshots, not append-deltas.
  entries: readonly PlanEntry[]
}
export type TimelineItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | FileChangeItem
  | ApprovalItem
  | QuestionItem
  | PlanItem

export type RunnerState = {
  id: RunnerId
  parentRunnerId?: RunnerId
  agentType?: string
  title?: string
  status: RunnerStatus
  items: TimelineItem[]
  usage?: Usage
  supportedModes?: readonly PermissionMode[]
  supportedAttachments?: AttachmentCapabilities
  error?: string
}
export type RunState = {
  rootRunnerId?: RunnerId
  runners: ReadonlyMap<RunnerId, RunnerState>
}

export const initialRunState: RunState = { runners: new Map() }

/** Return a new RunState with `runner` replacing whatever is at `runner.id`. */
const withRunner = (state: RunState, runner: RunnerState): RunState => {
  const runners = new Map(state.runners)
  runners.set(runner.id, runner)
  return { ...state, runners }
}

/** Apply a pure transform to one runner's items, returning a new RunState. */
const mapRunnerItems = (
  state: RunState,
  runnerId: RunnerId,
  transform: (items: TimelineItem[]) => TimelineItem[],
): RunState => {
  const runner = state.runners.get(runnerId)
  if (runner === undefined) return state
  return withRunner(state, { ...runner, items: transform(runner.items) })
}

export const reduce = (state: RunState, event: CanonicalEvent): RunState => {
  switch (event.type) {
    case "runner-started": {
      // `event.model` is intentionally not projected into RunnerState; it is
      // retained only in the StoredEvent envelope for audit / replay purposes.
      // Idempotent re-emit: the runtime marks the root runner started up front and the harness
      // may emit its own `runner-started` afterwards (e.g. claude's system/init). Preserve any
      // items/title already accumulated so the in-flight conversation is not reset to empty.
      const existing = state.runners.get(event.runnerId)
      // Resume continuation: a NEW root runner-started (a different id) arriving
      // when a prior root with history already exists is a resumed run — carry the
      // prior root's items forward so resume continues the conversation instead of
      // clearing it. The manager guarantees the backlog is folded before the
      // resumed run starts, so the prior root is already populated here.
      const priorRoot =
        existing === undefined &&
        event.parentRunnerId === undefined &&
        state.rootRunnerId !== undefined &&
        state.rootRunnerId !== event.runnerId
          ? state.runners.get(state.rootRunnerId)
          : undefined
      const title = event.title ?? existing?.title
      const agentType = event.agentType ?? existing?.agentType
      const parentRunnerId = event.parentRunnerId ?? existing?.parentRunnerId
      const supportedModes = event.supportedModes ?? existing?.supportedModes
      const supportedAttachments =
        event.supportedAttachments ?? existing?.supportedAttachments
      const runner: RunnerState = {
        id: event.runnerId,
        status: "running",
        items: existing?.items ?? priorRoot?.items ?? [],
        ...(parentRunnerId !== undefined ? { parentRunnerId } : {}),
        ...(agentType !== undefined ? { agentType } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(supportedModes !== undefined ? { supportedModes } : {}),
        ...(supportedAttachments !== undefined ? { supportedAttachments } : {}),
      }
      let next = withRunner(state, runner)
      if (event.parentRunnerId === undefined) {
        // The newest root becomes the rendered root. Idempotent for a same-id
        // re-emit (claude's system/init), and re-points to the resumed root so
        // the new turn renders under a runner that already holds the history.
        next = { ...next, rootRunnerId: event.runnerId }
      }
      if (
        event.parentRunnerId !== undefined &&
        event.spawnedByCallId !== undefined
      ) {
        const callId = event.spawnedByCallId
        next = mapRunnerItems(next, event.parentRunnerId, (items) =>
          items.map((item) =>
            item.kind === "tool-call" && item.callId === callId
              ? { ...item, spawnedRunnerId: event.runnerId }
              : item,
          ),
        )
      }
      return next
    }

    case "runner-finished": {
      const runner = state.runners.get(event.runnerId)
      if (runner === undefined) return state
      const updated: RunnerState = {
        ...runner,
        status: event.status,
      }
      if (event.error !== undefined) {
        updated.error = event.error
      }
      return withRunner(state, updated)
    }

    case "text-delta":
      return mapRunnerItems(state, event.runnerId, (items) => {
        const idx = items.findIndex(
          (i) => i.kind === "message" && i.messageId === event.messageId,
        )
        if (idx === -1) {
          return [
            ...items,
            {
              kind: "message",
              messageId: event.messageId,
              role: event.role ?? "assistant",
              text: event.text,
              ...(event.clientSendId !== undefined
                ? { clientSendId: event.clientSendId }
                : {}),
              ...(event.attachments !== undefined
                ? { attachments: [...event.attachments] }
                : {}),
            },
          ]
        }
        const existing = items[idx] as MessageItem
        // Idempotent on exact-text re-emit: double-replay of the stored event
        // must not concatenate the chunk again. If the re-emitted text matches
        // the current message text exactly, it's a duplicate — drop it.
        if (event.text === existing.text) return items
        const updated: MessageItem = {
          ...existing,
          text: existing.text + event.text,
        }
        return items.map((i, j) => (j === idx ? updated : i))
      })

    case "reasoning-delta":
      return mapRunnerItems(state, event.runnerId, (items) => {
        const idx = items.findIndex(
          (i) => i.kind === "reasoning" && i.messageId === event.messageId,
        )
        if (idx === -1) {
          return [
            ...items,
            { kind: "reasoning", messageId: event.messageId, text: event.text },
          ]
        }
        const existing = items[idx] as ReasoningItem
        const updated: ReasoningItem = {
          ...existing,
          text: existing.text + event.text,
        }
        return items.map((i, j) => (j === idx ? updated : i))
      })

    case "tool-call-started": {
      // Idempotent: the session-resume flow can deliver the same stored event
      // twice (manager replay + a redundant `run-attach`). Drop the duplicate
      // by `callId` so the timeline doesn't show the same call twice.
      if (
        state.runners
          .get(event.runnerId)
          ?.items.some(
            (i) => i.kind === "tool-call" && i.callId === event.callId,
          )
      )
        return state
      return mapRunnerItems(state, event.runnerId, (items) => [
        ...items,
        {
          kind: "tool-call",
          callId: event.callId,
          tool: event.tool,
          status: "running",
          ...(event.input !== undefined ? { input: event.input } : {}),
        },
      ])
    }

    case "tool-output-delta":
      return mapRunnerItems(state, event.runnerId, (items) =>
        items.map((item) =>
          item.kind === "tool-call" && item.callId === event.callId
            ? { ...item, output: (item.output ?? "") + event.chunk }
            : item,
        ),
      )

    case "tool-call-finished":
      return mapRunnerItems(state, event.runnerId, (items) =>
        items.map((item) =>
          item.kind === "tool-call" && item.callId === event.callId
            ? {
                ...item,
                status: event.status,
                ...(event.output !== undefined ? { output: event.output } : {}),
                ...(event.exitCode !== undefined
                  ? { exitCode: event.exitCode }
                  : {}),
                ...(event.result !== undefined ? { result: event.result } : {}),
              }
            : item,
        ),
      )

    case "file-change": {
      // Idempotent on `callId` when present: double-replay of the stored event
      // must not stack a second file-change row. File changes without a callId
      // are append-only by design (the harness may emit many per turn).
      if (event.callId !== undefined) {
        if (
          state.runners
            .get(event.runnerId)
            ?.items.some(
              (i) => i.kind === "file-change" && i.callId === event.callId,
            )
        )
          return state
      }
      return mapRunnerItems(state, event.runnerId, (items) => [
        ...items,
        {
          kind: "file-change",
          path: event.path,
          changeKind: event.kind,
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          ...(event.diff !== undefined ? { diff: event.diff } : {}),
        },
      ])
    }

    case "approval-requested": {
      // Idempotent on `requestId`: double-replay of the stored event must not
      // stack a second approval row.
      if (
        state.runners
          .get(event.runnerId)
          ?.items.some(
            (i) => i.kind === "approval" && i.requestId === event.requestId,
          )
      )
        return state
      return mapRunnerItems(state, event.runnerId, (items) => [
        ...items,
        { kind: "approval", requestId: event.requestId, target: event.target },
      ])
    }

    case "approval-resolved":
      return mapRunnerItems(state, event.runnerId, (items) =>
        items.map((item) =>
          item.kind === "approval" && item.requestId === event.requestId
            ? { ...item, decision: event.decision, by: event.by }
            : item,
        ),
      )

    case "question-requested": {
      // Idempotent on `requestId`: the webview runnerClient fans out every inbound
      // `runner-event` frame to both the per-session listener AND the firehose
      // `onAny` listener, so `applyEvent` runs twice per stored event. Without this
      // guard the same question would stack a duplicate QuestionItem in the timeline.
      if (
        state.runners
          .get(event.runnerId)
          ?.items.some(
            (i) => i.kind === "question" && i.requestId === event.requestId,
          )
      )
        return state
      return mapRunnerItems(state, event.runnerId, (items) => [
        ...items,
        { kind: "question", requestId: event.requestId, prompt: event.prompt },
      ])
    }

    case "question-resolved":
      return mapRunnerItems(state, event.runnerId, (items) =>
        items.map((item) =>
          item.kind === "question" && item.requestId === event.requestId
            ? { ...item, answer: event.answer }
            : item,
        ),
      )

    case "usage": {
      const runner = state.runners.get(event.runnerId)
      if (runner === undefined) return state
      return withRunner(state, { ...runner, usage: event.usage })
    }

    case "plan-update": {
      // Replace semantics keyed by planId: re-emitting the same plan replaces (not appends),
      // keeping the reducer idempotent on planId. Multiple distinct planIds are separate items.
      return mapRunnerItems(state, event.runnerId, (items) => {
        const existingIdx = items.findIndex(
          (i) => i.kind === "plan" && i.planId === event.planId,
        )
        const planItem: PlanItem = {
          kind: "plan",
          planId: event.planId,
          entries: event.entries,
        }
        if (existingIdx === -1) return [...items, planItem]
        return items.map((i, j) => (j === existingIdx ? planItem : i))
      })
    }

    case "turn-finished": {
      let next = state
      if (event.usage !== undefined) {
        const runner = next.runners.get(event.runnerId)
        if (runner !== undefined)
          next = withRunner(next, { ...runner, usage: event.usage })
      }
      // A turn error marks the referenced message with an error tone (the error text was already
      // streamed as that message); without a reference it appends its own error-toned message.
      // The runner stays "running" — the session is alive and the user can retry.
      if (event.error !== undefined) {
        const error = event.error
        next = mapRunnerItems(next, event.runnerId, (items) => {
          const idx = items.findIndex(
            (i) => i.kind === "message" && i.messageId === error.messageId,
          )
          if (idx === -1)
            return [
              ...items,
              {
                kind: "message",
                messageId: `turn-error-${items.length}`,
                role: "assistant",
                text: error.detail,
                tone: "error",
              },
            ]
          const existing = items[idx] as MessageItem
          return items.map((i, j) =>
            j === idx ? { ...existing, tone: "error" as const } : i,
          )
        })
      }
      return next
    }

    case "annotation":
      return state

    default:
      return state
  }
}
