import type { RunnerInbound, RunnerOutbound } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  PermissionMode,
  QuestionAnswer,
  StoredEvent,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type { ModelId, SessionId } from "@spectrum/types"

export type ConnectionState = "connecting" | "connected" | "reconnecting"

/**
 * Transport-agnostic runner client (twin of `terminalClient`). Encodes outbound
 * runner commands to `RunnerInbound` messages (handed to the injected `send`)
 * and routes inbound `RunnerOutbound` frames to a per-session event listener.
 * Pure + testable with a fake `send`; the WebSocket coupling lives in `clients.ts`.
 */
export interface RunnerClient {
  attach(id: SessionId): void
  send(id: SessionId, text: string, clientSendId?: string): void
  approve(id: SessionId, requestId: string, decision: ApprovalDecision): void
  answer(id: SessionId, requestId: string, answer: QuestionAnswer): void
  interrupt(id: SessionId): void
  setMode(id: SessionId, mode: PermissionMode): void
  setModel(id: SessionId, modelId: ModelId | null): void
  setThinkingEffort(id: SessionId, effort: ThinkingEffort): void
  /** route an inbound RunnerOutbound frame to the registered per-session listener */
  dispatch(message: RunnerOutbound): void
  onEvent(id: SessionId, cb: (event: StoredEvent) => void): void
  /**
   * Firehose: receive EVERY dispatched frame (any session, with or without a
   * per-session listener). Returns an unsubscribe fn — required so a re-running
   * effect can drop its previous listener instead of stacking duplicates.
   */
  onAny(cb: (id: SessionId, event: StoredEvent) => void): () => void
  /** Live session-name push (session-renamed frame). Returns an unsubscribe fn. */
  onSessionRenamed(cb: (id: SessionId, name: string) => void): () => void
  /**
   * Resume-token observability frame (session-resume-token). The empty string signals
   * a fresh restart (no resumable history). Returns an unsubscribe fn.
   */
  onResumeToken(cb: (id: SessionId, resumeToken: string) => void): () => void
  /** The transport lost its socket (error/close); fans out to onConnectionLost subscribers. */
  connectionLost(): void
  /** Subscribe to transport-loss notifications. Returns an unsubscribe fn. */
  onConnectionLost(cb: () => void): () => void
  /** Push the current transport connection state (transport → client). */
  reportConnectionState(state: ConnectionState): void
  /** Subscribe to connection-state changes. Returns an unsubscribe fn. */
  onConnectionState(cb: (state: ConnectionState) => void): () => void
  /** The latest connection state (starts "connecting"). */
  connectionState(): ConnectionState
  /** Wall-clock ms of the most recent inbound frame (0 until the transport overrides). */
  getLastFrameMs(): number
  /** Force the transport to drop and re-establish the socket (no-op for the pure client). */
  reconnect(): void
}

export const createRunnerClient = (
  send: (message: RunnerInbound) => void,
): RunnerClient => {
  // One conversation owns one session, so a single listener per session suffices.
  const listeners = new Map<SessionId, (event: StoredEvent) => void>()
  // Firehose listeners receive every frame (e.g. background-run notifications).
  const anyListeners = new Set<(id: SessionId, event: StoredEvent) => void>()
  const renameListeners = new Set<(id: SessionId, name: string) => void>()
  const resumeTokenListeners = new Set<
    (id: SessionId, resumeToken: string) => void
  >()
  const connectionLostListeners = new Set<() => void>()
  const connectionStateListeners = new Set<(s: ConnectionState) => void>()
  let currentConnectionState: ConnectionState = "connecting"

  type Dispatcher = (message: RunnerOutbound) => void
  const dispatchers: Map<RunnerOutbound["type"], Dispatcher> = new Map([
    [
      "session-renamed",
      (m) => {
        if (m.type === "session-renamed")
          for (const cb of renameListeners) cb(m.id, m.name)
      },
    ],
    [
      "session-resume-token",
      (m) => {
        if (m.type === "session-resume-token")
          for (const cb of resumeTokenListeners) cb(m.id, m.resumeToken)
      },
    ],
    [
      "runner-event",
      (m) => {
        if (m.type === "runner-event") {
          listeners.get(m.id)?.(m.event)
          for (const cb of anyListeners) cb(m.id, m.event)
        }
      },
    ],
  ])

  return {
    attach: (id) => {
      send({ type: "run-attach", id })
    },
    send: (id, text, clientSendId) => {
      send({
        type: "run-send",
        id,
        text,
        ...(clientSendId !== undefined ? { clientSendId } : {}),
      })
    },
    approve: (id, requestId, decision) => {
      send({ type: "run-approve", id, requestId, decision })
    },
    answer: (id, requestId, answer) => {
      send({ type: "run-answer", id, requestId, answer })
    },
    interrupt: (id) => {
      send({ type: "run-interrupt", id })
    },
    setMode: (id, mode) => {
      send({ type: "run-set-mode", id, mode })
    },
    setModel: (id, modelId) => {
      send({ type: "run-set-model", id, modelId })
    },
    setThinkingEffort: (id, effort) => {
      send({ type: "run-set-thinking-effort", id, effort })
    },
    dispatch: (message) => {
      const dispatcher = dispatchers.get(message.type)
      if (typeof dispatcher !== "function") return
      dispatcher(message)
    },
    onEvent: (id, cb) => {
      listeners.set(id, cb)
    },
    onAny: (cb) => {
      anyListeners.add(cb)
      return () => {
        anyListeners.delete(cb)
      }
    },
    onSessionRenamed: (cb) => {
      renameListeners.add(cb)
      return () => {
        renameListeners.delete(cb)
      }
    },
    onResumeToken: (cb) => {
      resumeTokenListeners.add(cb)
      return () => {
        resumeTokenListeners.delete(cb)
      }
    },
    connectionLost: () => {
      for (const cb of connectionLostListeners) cb()
    },
    onConnectionLost: (cb) => {
      connectionLostListeners.add(cb)
      return () => {
        connectionLostListeners.delete(cb)
      }
    },
    reportConnectionState: (state) => {
      currentConnectionState = state
      for (const cb of connectionStateListeners) cb(state)
    },
    onConnectionState: (cb) => {
      connectionStateListeners.add(cb)
      return () => {
        connectionStateListeners.delete(cb)
      }
    },
    connectionState: () => currentConnectionState,
    getLastFrameMs: () => 0,
    reconnect: () => {},
  }
}
