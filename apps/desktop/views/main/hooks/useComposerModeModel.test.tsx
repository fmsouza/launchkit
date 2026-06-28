import { describe, expect, it, mock } from "bun:test"
import { HarnessIdSchema, SessionIdSchema } from "@spectrum/types"
import { act, renderHook } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { StoreProvider, type Stores, useStores } from "../stores/createStores"
import { type FakeIpcClient, createFakeIpcClient } from "../test/fake-client"
import { createUpdateClient } from "../update/updateClient"
import {
  type ComposerForward,
  type ComposerSeed,
  useComposerModeModel,
} from "./useComposerModeModel"

const sid = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")
const hid = HarnessIdSchema.parse("h_claude-code")

/**
 * Render the hook with the real `StoreProvider` + `IpcClientProvider` so the
 * hook sees the same `runView` zustand store we drive via the ref captured in
 * the wrapper. Returns the live store plus a fresh handle to the hook result.
 */
const renderWith = (
  client: FakeIpcClient,
  args: {
    readonly seed?: ComposerSeed
    readonly forward?: ComposerForward
    /** Pass `null` to render with `harnessId: undefined`. Omit to use `hid`. */
    readonly harnessId?: typeof hid | null
  } = {},
) => {
  const resolvedHarnessId =
    "harnessId" in args ? (args.harnessId ?? undefined) : hid
  const storeRef: { current: Stores["runView"] | undefined } = {
    current: undefined,
  }
  const Capture = (): null => {
    storeRef.current = useStores().runView
    return null
  }
  const hook = renderHook(
    () => useComposerModeModel(sid, resolvedHarnessId, args.seed, args.forward),
    {
      wrapper: ({ children }) => (
        <IpcClientProvider client={client}>
          <StoreProvider client={client} updateClient={createUpdateClient()}>
            <Capture />
            {children}
          </StoreProvider>
        </IpcClientProvider>
      ),
    },
  )
  const store = storeRef.current
  if (store === undefined) throw new Error("store not captured")
  return { store, ...hook }
}

describe("useComposerModeModel", () => {
  it("returns stored mode/model, defaulting to manual/empty when unset", () => {
    const client = createFakeIpcClient({})
    const { result } = renderWith(client)
    expect(result.current.mode).toBe("manual")
    expect(result.current.model).toBe("")
  })

  it("seeds mode/model from the seed once (replay path)", () => {
    const client = createFakeIpcClient({})
    const { store, result } = renderWith(client, {
      seed: { mode: "plan", model: "mdl_x" },
    })
    expect(store.getState().modeBySession[sid]).toBe("plan")
    expect(store.getState().modelBySession[sid]).toBe("mdl_x")
    expect(result.current.mode).toBe("plan")
    expect(result.current.model).toBe("mdl_x")
  })

  it("onModeChange writes the store + harness pref, and forwards only when forward is present", () => {
    const client = createFakeIpcClient({
      updateHarnessPrefs: async () => ({ ok: true, value: null }),
    })
    const setModeForward = mock(() => {})
    const setModelForward = mock(() => {})
    const { store, result } = renderWith(client, {
      forward: { setMode: setModeForward, setModel: setModelForward },
    })
    act(() => result.current.onModeChange("bypass"))
    expect(store.getState().modeBySession[sid]).toBe("bypass")
    expect(setModeForward).toHaveBeenCalledWith(sid, "bypass")
    expect(client.calls.updateHarnessPrefs).toEqual([
      { harnessId: hid, mode: "bypass" },
    ])

    // Replay path: forward absent → persist + pref, but no forward call.
    const replayClient = createFakeIpcClient({
      updateHarnessPrefs: async () => ({ ok: true, value: null }),
    })
    const replay = renderHook(
      () => useComposerModeModel(sid, hid, undefined, undefined),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={replayClient}>
            <StoreProvider
              client={replayClient}
              updateClient={createUpdateClient()}
            >
              {children}
            </StoreProvider>
          </IpcClientProvider>
        ),
      },
    )
    act(() => replay.result.current.onModeChange("auto-edits"))
    expect(replay.result.current.mode).toBe("auto-edits")
    expect(setModeForward).toHaveBeenCalledTimes(1) // still only the first call
  })

  it("onModelChange writes the store + harness pref, forwarding null for empty string when forward present", () => {
    const client = createFakeIpcClient({
      updateHarnessPrefs: async () => ({ ok: true, value: null }),
    })
    const setModelForward = mock(() => {})
    const setModeForward = mock(() => {})
    const { store, result } = renderWith(client, {
      forward: { setMode: setModeForward, setModel: setModelForward },
    })
    act(() => result.current.onModelChange("mdl_new"))
    expect(store.getState().modelBySession[sid]).toBe("mdl_new")
    expect(setModelForward).toHaveBeenCalledWith(sid, "mdl_new")
    expect(client.calls.updateHarnessPrefs).toEqual([
      { harnessId: hid, modelId: "mdl_new" },
    ])

    act(() => result.current.onModelChange("")) // default clears the override
    expect(setModelForward).toHaveBeenCalledWith(sid, null)
  })

  it("skips harness pref when harnessId is undefined", () => {
    const client = createFakeIpcClient({
      updateHarnessPrefs: async () => ({ ok: true, value: null }),
    })
    const { result } = renderWith(client, { harnessId: undefined })
    act(() => result.current.onModeChange("plan"))
    expect(client.calls.updateHarnessPrefs).toEqual([])
  })

  it("does not re-seed on re-render when already set", () => {
    const client = createFakeIpcClient({})
    const { store, rerender } = renderWith(client, {
      seed: { mode: "plan", model: "mdl_x" },
    })
    // user changes model after seed
    act(() => store.getState().setModel(sid, "mdl_user"))
    rerender()
    expect(store.getState().modelBySession[sid]).toBe("mdl_user") // seed did not clobber
  })
})
