import { describe, expect, it } from "bun:test"
import type {
  FlowResultViewData,
  FlowStepViewData,
  FlowToastViewData,
  IpcError,
  IpcMethods,
} from "@spectrum/ipc"
import type { Result } from "@spectrum/utils"
import { act, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { useNotifications } from "./useNotifications"
import type { StartProviderFlowInput, UseProviderFlow } from "./useProviderFlow"
import { useProviderFlow } from "./useProviderFlow"

const startParams: StartProviderFlowInput = {
  providerKey: "plugin:acme",
  flowId: "signin",
  context: "create",
  config: {},
}

type FlowScript = {
  readonly steps: readonly FlowStepViewData[]
  readonly toast?: FlowToastViewData
}

type ToastSnapshot = { readonly tone: string; readonly message: string }

/**
 * `renderHook` can't drive this hook: `useProviderFlow` reads BOTH the injected IPC client
 * and the zustand notifications store, and a bare `renderHook` throws on the store lookup.
 * Follows this directory's actual convention (`useProviders.test.tsx`): mount a `Probe`
 * inside `renderWithProviders` and capture the hook's latest return value on every render.
 * A second hook call in the same probe (`useNotifications`) exposes what the flow hook
 * pushed to the notifications engine, without asserting against the store directly.
 */
const renderFlowHook = (
  script: FlowScript,
): {
  readonly hook: { current: UseProviderFlow }
  readonly ipc: {
    readonly advances: Array<{
      readonly sessionId: string
      readonly result: FlowResultViewData
    }>
    readonly cancelled: string[]
  }
  readonly notifications: readonly ToastSnapshot[]
  readonly unmount: () => void
} => {
  const sessionId = "sess_1"
  const advances: Array<{
    readonly sessionId: string
    readonly result: FlowResultViewData
  }> = []
  const cancelled: string[] = []
  let stepIndex = 0

  const client = createFakeIpcClient({
    startProviderFlow: async () => {
      const first = script.steps[0]
      if (first === undefined) {
        throw new Error("renderFlowHook script needs at least one step")
      }
      stepIndex = 0
      return {
        ok: true,
        value: {
          sessionId,
          step: first,
          ...(script.toast !== undefined ? { toast: script.toast } : {}),
        },
      }
    },
    advanceProviderFlow: async (params) => {
      advances.push({ sessionId: params.sessionId, result: params.result })
      stepIndex += 1
      const next = script.steps[stepIndex]
      return {
        ok: true,
        value:
          next === undefined
            ? { sessionId: params.sessionId }
            : { sessionId: params.sessionId, step: next },
      }
    },
    cancelProviderFlow: async (params) => {
      cancelled.push(params.sessionId)
      return { ok: true, value: null }
    },
  })

  const hookRef: { current: UseProviderFlow } = {
    current: undefined as unknown as UseProviderFlow,
  }
  const notificationsRef: { current: readonly ToastSnapshot[] } = {
    current: [],
  }

  const Probe = (): JSX.Element => {
    hookRef.current = useProviderFlow()
    const { notifications } = useNotifications()
    notificationsRef.current = notifications.map((n) => ({
      tone: n.tone,
      message: n.message,
    }))
    return null as unknown as JSX.Element
  }

  const { unmount } = renderWithProviders(<Probe />, client)

  return {
    hook: hookRef,
    ipc: { advances, cancelled },
    get notifications() {
      return notificationsRef.current
    },
    unmount,
  }
}

describe("useProviderFlow", () => {
  it("polls at the step's interval while the step is await", async () => {
    const { hook, ipc } = renderFlowHook({
      steps: [
        { kind: "await", title: "Waiting", pollMs: 500 },
        { kind: "await", title: "Waiting", pollMs: 500 },
        { kind: "done", message: "ok" },
      ],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    await waitFor(() => expect(ipc.advances.length).toBeGreaterThanOrEqual(1))
    expect(ipc.advances[0]?.result).toEqual({ kind: "poll" })
  })

  it("stops polling once a non-await step arrives", async () => {
    const { hook, ipc } = renderFlowHook({
      steps: [
        { kind: "await", title: "Waiting", pollMs: 500 },
        { kind: "form", title: "Sign in", fields: [] },
      ],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    await waitFor(() => expect(hook.current.step?.kind).toBe("form"))
    const seen = ipc.advances.length
    await new Promise((r) => setTimeout(r, 1200))
    expect(ipc.advances.length).toBe(seen)
  })

  it("stops polling and clears the session when cancel is called", async () => {
    const { hook, ipc } = renderFlowHook({
      steps: [{ kind: "await", title: "Waiting", pollMs: 500 }],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    await act(async () => {
      await hook.current.cancel()
    })
    expect(hook.current.step).toBeUndefined()
    expect(ipc.cancelled.length).toBe(1)
  })

  it("surfaces a plugin-supplied toast through the notifications engine", async () => {
    // Not destructured: `notifications` is a getter, so reading it off `env` re-evaluates
    // on each access. Destructuring it once would freeze it at its pre-start empty value.
    const env = renderFlowHook({
      steps: [{ kind: "form", title: "Sign in", fields: [] }],
      toast: { tone: "info", message: "Check your browser" },
    })
    await act(async () => {
      await env.hook.current.start(startParams)
    })
    expect(env.notifications).toContainEqual({
      tone: "info",
      message: "Check your browser",
    })
  })

  it("clears the session when a done step arrives", async () => {
    const { hook } = renderFlowHook({
      steps: [{ kind: "done", message: "ok" }],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    await waitFor(() => expect(hook.current.sessionId).toBeUndefined())
  })

  it("clears the session and notifies when an error step arrives", async () => {
    const env = renderFlowHook({
      steps: [{ kind: "error", message: "Auth denied" }],
    })
    await act(async () => {
      await env.hook.current.start(startParams)
    })
    await waitFor(() => expect(env.hook.current.sessionId).toBeUndefined())
    expect(env.notifications.some((n) => n.tone === "error")).toBe(true)
  })

  it("cancels the in-flight flow when the hook unmounts", async () => {
    const { hook, ipc, unmount } = renderFlowHook({
      steps: [{ kind: "form", title: "Sign in", fields: [] }],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    const sessionId = hook.current.sessionId
    if (sessionId === undefined) throw new Error("expected a live sessionId")
    unmount()
    await waitFor(() => expect(ipc.cancelled).toEqual([sessionId]))
  })

  it("does not cancel on unmount when the flow already finished", async () => {
    const { hook, ipc, unmount } = renderFlowHook({
      steps: [{ kind: "done", message: "ok" }],
    })
    await act(async () => {
      await hook.current.start(startParams)
    })
    unmount()
    expect(ipc.cancelled).toEqual([])
  })

  it("does not advance or cancel when start returns no sessionId", async () => {
    const client = createFakeIpcClient({
      startProviderFlow: async () => ({
        ok: true,
        value: { step: { kind: "error", message: "unsupported provider" } },
      }),
      advanceProviderFlow: async () => {
        throw new Error("advance must not be called")
      },
      cancelProviderFlow: async () => {
        throw new Error("cancel must not be called")
      },
    })
    const hookRef: { current: UseProviderFlow } = {
      current: undefined as unknown as UseProviderFlow,
    }
    const Probe = (): JSX.Element => {
      hookRef.current = useProviderFlow()
      return null as unknown as JSX.Element
    }
    renderWithProviders(<Probe />, client)
    await act(async () => {
      await hookRef.current.start(startParams)
    })
    expect(hookRef.current.step).toEqual({
      kind: "error",
      message: "unsupported provider",
    })
    expect(hookRef.current.sessionId).toBeUndefined()
  })

  it("keeps the current step and does not error when advance returns no step", async () => {
    let advanceCalls = 0
    const client = createFakeIpcClient({
      startProviderFlow: async () => ({
        ok: true,
        value: {
          sessionId: "sess_1",
          step: { kind: "await", title: "Waiting", pollMs: 20_000 },
        },
      }),
      advanceProviderFlow: async () => {
        advanceCalls += 1
        return { ok: true, value: { sessionId: "sess_1" } }
      },
      cancelProviderFlow: async () => ({ ok: true, value: null }),
    })
    const hookRef: { current: UseProviderFlow } = {
      current: undefined as unknown as UseProviderFlow,
    }
    const Probe = (): JSX.Element => {
      hookRef.current = useProviderFlow()
      return null as unknown as JSX.Element
    }
    renderWithProviders(<Probe />, client)
    await act(async () => {
      await hookRef.current.start(startParams)
    })
    await act(async () => {
      await hookRef.current.submit({})
    })
    expect(advanceCalls).toBe(1)
    expect(hookRef.current.step?.kind).toBe("await")
    expect(hookRef.current.sessionId).toBe("sess_1")
  })

  it("ignores a poll response that resolves after cancel (in-flight advance is stale)", async () => {
    type AdvanceResult = Result<
      IpcMethods["advanceProviderFlow"]["result"],
      IpcError
    >
    let resolveAdvance: ((value: AdvanceResult) => void) | undefined
    const advanceCalls: FlowResultViewData[] = []
    const cancelled: string[] = []
    const client = createFakeIpcClient({
      startProviderFlow: async () => ({
        ok: true,
        value: {
          sessionId: "sess_1",
          step: { kind: "await", title: "Waiting", pollMs: 10 },
        },
      }),
      advanceProviderFlow: async (params) => {
        advanceCalls.push(params.result)
        return new Promise<AdvanceResult>((resolve) => {
          resolveAdvance = resolve
        })
      },
      cancelProviderFlow: async (params) => {
        cancelled.push(params.sessionId)
        return { ok: true, value: null }
      },
    })
    const hookRef: { current: UseProviderFlow } = {
      current: undefined as unknown as UseProviderFlow,
    }
    const Probe = (): JSX.Element => {
      hookRef.current = useProviderFlow()
      return null as unknown as JSX.Element
    }
    renderWithProviders(<Probe />, client)
    await act(async () => {
      await hookRef.current.start(startParams)
    })
    // Let the poll timer fire so its `advance` call is genuinely in flight (parked on the
    // unresolved promise above) before we cancel.
    await waitFor(() => expect(advanceCalls.length).toBe(1))

    await act(async () => {
      await hookRef.current.cancel()
    })
    expect(hookRef.current.sessionId).toBeUndefined()
    expect(hookRef.current.step).toBeUndefined()
    expect(cancelled).toEqual(["sess_1"])

    // The stale in-flight advance now resolves, carrying a step that would otherwise
    // re-arm the (already-cancelled) session.
    await act(async () => {
      resolveAdvance?.({
        ok: true,
        value: {
          sessionId: "sess_1",
          step: { kind: "await", title: "Waiting", pollMs: 10 },
        },
      })
    })
    expect(hookRef.current.sessionId).toBeUndefined()
    expect(hookRef.current.step).toBeUndefined()
    // Only the one explicit cancel call — the stale response must not trigger another.
    expect(cancelled).toEqual(["sess_1"])
  })

  it("ignores a start response that resolves after cancel (cancel raced the very first start)", async () => {
    type StartResult = Result<
      IpcMethods["startProviderFlow"]["result"],
      IpcError
    >
    let resolveStart: ((value: StartResult) => void) | undefined
    const cancelled: string[] = []
    const client = createFakeIpcClient({
      startProviderFlow: async () =>
        new Promise<StartResult>((resolve) => {
          resolveStart = resolve
        }),
      cancelProviderFlow: async (params) => {
        cancelled.push(params.sessionId)
        return { ok: true, value: null }
      },
    })
    const hookRef: { current: UseProviderFlow } = {
      current: undefined as unknown as UseProviderFlow,
    }
    const Probe = (): JSX.Element => {
      hookRef.current = useProviderFlow()
      return null as unknown as JSX.Element
    }
    renderWithProviders(<Probe />, client)

    // Don't await: `start` is left in flight while we cancel underneath it. There is no
    // session yet, so `cancel` has nothing to tell the server about, but it must still
    // invalidate whatever `start` eventually resolves with.
    let startPromise: Promise<void> = Promise.resolve()
    act(() => {
      startPromise = hookRef.current.start(startParams)
    })
    await act(async () => {
      await hookRef.current.cancel()
    })
    expect(cancelled).toEqual([])

    await act(async () => {
      resolveStart?.({
        ok: true,
        value: {
          sessionId: "sess_1",
          step: { kind: "form", title: "Sign in", fields: [] },
        },
      })
      await startPromise
    })
    expect(hookRef.current.sessionId).toBeUndefined()
    expect(hookRef.current.step).toBeUndefined()
  })
})
