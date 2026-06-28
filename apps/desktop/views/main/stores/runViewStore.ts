import {
  type CanonicalEvent,
  type PermissionMode,
  type RunState,
  type RunnerId,
  type ThinkingEffort,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import type { SessionId } from "@spectrum/types"
import { type StoreApi, createStore } from "zustand/vanilla"
import type { StoreDeps } from "./types"

export type RunViewStore = {
  readonly byId: Readonly<Record<string, RunState>>
  readonly openSubBySession: Readonly<Record<string, RunnerId>>
  /** Whether a turn is in flight (drives the typing indicator) — see `nextBusy`. */
  readonly busyBySession: Readonly<Record<string, boolean>>
  readonly modeBySession: Readonly<Record<string, PermissionMode>>
  readonly modelBySession: Readonly<Record<string, string>>
  readonly thinkingEffortBySession: Readonly<Record<string, ThinkingEffort>>
  readonly applyEvent: (sessionId: SessionId, event: CanonicalEvent) => void
  readonly reset: (sessionId: SessionId) => void
  readonly openSub: (sessionId: SessionId, runnerId: RunnerId) => void
  readonly closeSub: (sessionId: SessionId) => void
  readonly setMode: (sessionId: SessionId, mode: PermissionMode) => void
  readonly setModel: (sessionId: SessionId, modelId: string) => void
  readonly setThinkingEffort: (
    sessionId: SessionId,
    effort: ThinkingEffort,
  ) => void
  /** Seed the composer mode, model, and thinking-effort once (replay: from the folded root runner-started).
   *  Idempotent: writes only when the slot is undefined. No-op if seed is empty. */
  readonly seedModeModel: (
    sessionId: SessionId,
    seed: {
      readonly mode?: PermissionMode
      readonly model?: string
      readonly effort?: ThinkingEffort
    },
  ) => void
}

/**
 * Derive the next "busy" (turn-in-flight) flag from an event. A turn begins when the user sends (the
 * runtime echoes it as a role:user text-delta) and ends when the ROOT runner reports the turn/run done
 * (`turn-finished` for streaming harnesses like opencode; `runner-finished` for claude/codex/openclaw).
 */
const nextBusy = (
  prev: boolean,
  event: CanonicalEvent,
  state: RunState,
): boolean => {
  if (event.type === "text-delta" && event.role === "user") return true
  const root = state.rootRunnerId
  if (
    (event.type === "turn-finished" || event.type === "runner-finished") &&
    event.runnerId === root
  )
    return false
  return prev
}

/**
 * Webview store of reduced `RunState` per session (the §3.6 `runViewStore`,
 * distinct from the backend `RunStore`). `RunDetail` owns the socket and calls
 * `applyEvent` for each inbound frame; the shared `reduce` does the folding so
 * live and replay produce identical state. `deps` is unused (kept for bundle
 * symmetry with the IPC-backed stores).
 */
export const createRunViewStore = (_deps: StoreDeps): StoreApi<RunViewStore> =>
  createStore<RunViewStore>()((set, get) => ({
    byId: {},
    openSubBySession: {},
    busyBySession: {},
    modeBySession: {},
    modelBySession: {},
    thinkingEffortBySession: {},

    applyEvent: (sessionId, event) => {
      const prev = get().byId[sessionId] ?? initialRunState
      const next = reduce(prev, event)
      const busy = nextBusy(
        get().busyBySession[sessionId] ?? false,
        event,
        next,
      )
      set((state) => {
        const updated: {
          byId: Readonly<Record<string, RunState>>
          busyBySession: Readonly<Record<string, boolean>>
          modeBySession?: Readonly<Record<string, PermissionMode>>
          modelBySession?: Readonly<Record<string, string>>
          thinkingEffortBySession?: Readonly<Record<string, ThinkingEffort>>
        } = {
          byId: { ...state.byId, [sessionId]: next },
          busyBySession: { ...state.busyBySession, [sessionId]: busy },
        }
        // Seed the composer mode, model, and thinking-effort from the driver's reported applied
        // values, but only when nothing is set yet — so a benign re-emit of runner-started (claude's
        // system/init) or a later user change is never clobbered. The driver is the source of truth
        // for the *initial* mode, model, and thinking-effort.
        if (event.type !== "runner-started") return updated
        if (
          event.permissionMode !== undefined &&
          state.modeBySession[sessionId] === undefined
        ) {
          updated.modeBySession = {
            ...state.modeBySession,
            [sessionId]: event.permissionMode,
          }
        }
        if (
          event.model !== undefined &&
          state.modelBySession[sessionId] === undefined
        ) {
          updated.modelBySession = {
            ...state.modelBySession,
            [sessionId]: event.model,
          }
        }
        if (
          event.thinkingEffort !== undefined &&
          state.thinkingEffortBySession[sessionId] === undefined
        ) {
          updated.thinkingEffortBySession = {
            ...state.thinkingEffortBySession,
            [sessionId]: event.thinkingEffort,
          }
        }
        return updated
      })
    },

    reset: (sessionId) => {
      set((state) => {
        const { [sessionId]: _removed, ...rest } = state.byId
        const { [sessionId]: _sub, ...subRest } = state.openSubBySession
        const { [sessionId]: _busy, ...busyRest } = state.busyBySession
        const { [sessionId]: _mode, ...modeRest } = state.modeBySession
        const { [sessionId]: _model, ...modelRest } = state.modelBySession
        const { [sessionId]: _eff, ...effRest } = state.thinkingEffortBySession
        return {
          byId: rest,
          openSubBySession: subRest,
          busyBySession: busyRest,
          modeBySession: modeRest,
          modelBySession: modelRest,
          thinkingEffortBySession: effRest,
        }
      })
    },

    openSub: (sessionId, runnerId) => {
      set((state) => ({
        openSubBySession: { ...state.openSubBySession, [sessionId]: runnerId },
      }))
    },

    closeSub: (sessionId) => {
      set((state) => {
        const { [sessionId]: _removed, ...rest } = state.openSubBySession
        return { openSubBySession: rest }
      })
    },

    setMode: (sessionId, mode) => {
      set((state) => ({
        modeBySession: { ...state.modeBySession, [sessionId]: mode },
      }))
    },

    setModel: (sessionId, modelId) => {
      set((state) => ({
        modelBySession: { ...state.modelBySession, [sessionId]: modelId },
      }))
    },

    setThinkingEffort: (sessionId, effort) => {
      set((state) => ({
        thinkingEffortBySession: {
          ...state.thinkingEffortBySession,
          [sessionId]: effort,
        },
      }))
    },

    seedModeModel: (sessionId, seed) => {
      if (
        seed.mode === undefined &&
        seed.model === undefined &&
        seed.effort === undefined
      )
        return
      set((state) => {
        const next = { ...state }
        if (
          seed.mode !== undefined &&
          state.modeBySession[sessionId] === undefined
        ) {
          next.modeBySession = {
            ...state.modeBySession,
            [sessionId]: seed.mode,
          }
        }
        if (
          seed.model !== undefined &&
          state.modelBySession[sessionId] === undefined
        ) {
          next.modelBySession = {
            ...state.modelBySession,
            [sessionId]: seed.model,
          }
        }
        if (
          seed.effort !== undefined &&
          state.thinkingEffortBySession[sessionId] === undefined
        ) {
          next.thinkingEffortBySession = {
            ...state.thinkingEffortBySession,
            [sessionId]: seed.effort,
          }
        }
        return next
      })
    },
  }))
