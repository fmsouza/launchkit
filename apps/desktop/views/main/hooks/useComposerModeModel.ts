import type { PermissionMode, ThinkingEffort } from "@spectrum/agent-events"
import type { HarnessId, ModelId, SessionId } from "@spectrum/types"
import { useEffect } from "react"
import { useStore } from "zustand"
import { useIpcClient } from "../IpcClientContext"
import { useStores } from "../stores/createStores"

/** The live-only socket forwarding injected into the hook. Absent in replay. */
export type ComposerForward = {
  readonly setMode: (sessionId: SessionId, mode: PermissionMode) => void
  readonly setModel: (sessionId: SessionId, modelId: ModelId | null) => void
  readonly setThinkingEffort: (
    sessionId: SessionId,
    effort: ThinkingEffort,
  ) => void
}

/** The replay seed from the folded root runner-started event. Absent in live. */
export type ComposerSeed = {
  readonly mode?: PermissionMode
  readonly model?: string
  readonly effort?: ThinkingEffort
}

export type UseComposerModeModelResult = {
  readonly mode: PermissionMode
  readonly onModeChange: (mode: PermissionMode) => void
  readonly model: string
  readonly onModelChange: (modelId: string) => void
  readonly effort: ThinkingEffort
  readonly onEffortChange: (effort: ThinkingEffort) => void
}

/**
 * Shared mode/model read+write+seed wiring for the composer dropdowns. Both
 * `LiveRunDetail` and `ReplayRunDetail` call this so the dropdowns always
 * render and stay editable. Live passes `forward` (the runnerClient socket
 * methods); replay passes `seed` (the folded root runner-started values) and
 * no `forward` (no socket until resume-send flips the session to live).
 *
 * Seeding is idempotent: `seedModeModel` writes only when the store slot is
 * undefined, so the live `applyEvent` re-seed never clobbers a value the user
 * already changed in replay.
 */
export const useComposerModeModel = (
  sessionId: SessionId,
  harnessId: HarnessId | undefined,
  seed: ComposerSeed | undefined,
  forward: ComposerForward | undefined,
): UseComposerModeModelResult => {
  const client = useIpcClient()
  const store = useStores().runView
  const mode = useStore(store, (s) => s.modeBySession[sessionId] ?? "manual")
  const model = useStore(store, (s) => s.modelBySession[sessionId] ?? "")
  const effort = useStore(
    store,
    (s) => s.thinkingEffortBySession[sessionId] ?? "medium",
  )
  const setMode = useStore(store, (s) => s.setMode)
  const setModel = useStore(store, (s) => s.setModel)
  const setThinkingEffort = useStore(store, (s) => s.setThinkingEffort)
  const seedModeModel = useStore(store, (s) => s.seedModeModel)

  // Seed once per (sessionId, seed). The store guard makes it idempotent.
  useEffect(() => {
    if (seed === undefined) return
    seedModeModel(sessionId, seed)
  }, [sessionId, seed, seedModeModel])

  const onModeChange = (m: PermissionMode): void => {
    setMode(sessionId, m)
    forward?.setMode(sessionId, m)
    if (harnessId !== undefined)
      void client.updateHarnessPrefs({ harnessId, mode: m })
  }

  const onModelChange = (modelId: string): void => {
    setModel(sessionId, modelId)
    // Forward to the live session: a real id routes via the proxy, "" (default)
    // clears the model so the session switches back to the harness's own
    // subscription/credentials. Absent forward in replay: persist only.
    forward?.setModel(sessionId, modelId === "" ? null : (modelId as ModelId))
    if (harnessId !== undefined)
      void client.updateHarnessPrefs({ harnessId, modelId })
  }

  const onEffortChange = (e: ThinkingEffort): void => {
    setThinkingEffort(sessionId, e)
    forward?.setThinkingEffort(sessionId, e)
    if (harnessId !== undefined)
      void client.updateHarnessPrefs({ harnessId, thinkingEffort: e })
  }

  return { mode, onModeChange, model, onModelChange, effort, onEffortChange }
}
