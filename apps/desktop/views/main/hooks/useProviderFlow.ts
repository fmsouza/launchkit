import type {
  FlowResultViewData,
  FlowStepViewData,
  FlowToastViewData,
} from "@spectrum/ipc"
import type { ProviderId, ProviderKey } from "@spectrum/types"
import { useEffect, useRef, useState } from "react"
import { useIpcClient } from "../IpcClientContext"
import { useNotifications } from "./useNotifications"

export type StartProviderFlowInput = {
  readonly providerKey: ProviderKey
  readonly flowId: string
  readonly context: "create" | "provider"
  readonly config: Readonly<Record<string, string>>
  /** Present only for `context: "provider"` — names the record to re-authenticate. */
  readonly providerId?: ProviderId
}

export type UseProviderFlow = {
  readonly step: FlowStepViewData | undefined
  readonly sessionId: string | undefined
  readonly busy: boolean
  readonly start: (input: StartProviderFlowInput) => Promise<void>
  readonly submit: (values: Readonly<Record<string, string>>) => Promise<void>
  readonly ack: () => Promise<void>
  readonly cancel: () => Promise<void>
}

/**
 * Drives one extension-contributed setup flow over IPC. Owns the `await` polling timer, at
 * the runner-clamped `pollMs` delivered with the step — never a value the plugin chose
 * directly — and the session lifecycle (start → submit/ack/poll → done/error/cancel). The
 * modal that hosts this hook renders whatever `step` holds; this hook renders nothing.
 */
export const useProviderFlow = (): UseProviderFlow => {
  const client = useIpcClient()
  const { notify } = useNotifications()

  const [step, setStep] = useState<FlowStepViewData | undefined>(undefined)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<boolean>(false)

  // Refs mirror the state above for use inside the poll timer and the unmount cleanup,
  // which must read the CURRENT value synchronously rather than whatever a stale render
  // closure captured.
  const sessionRef = useRef<string | undefined>(undefined)
  const stepRef = useRef<FlowStepViewData | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearPoll = (): void => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }

  const setLiveStep = (s: FlowStepViewData | undefined): void => {
    stepRef.current = s
    setStep(s)
  }

  const endSession = (): void => {
    clearPoll()
    sessionRef.current = undefined
    setSessionId(undefined)
  }

  const showToast = (toast: FlowToastViewData | undefined): void => {
    if (toast !== undefined) notify(toast)
  }

  const schedulePoll = (sid: string, pollMs: number): void => {
    clearPoll()
    timerRef.current = setTimeout(() => {
      void advance(sid, { kind: "poll" })
    }, pollMs)
  }

  /** Applies a step delivered by `start` or `advance`. `done`/`error` are terminal: the
   * session ends and (for `error`) the failure reaches the user via the notifications
   * engine. Any other kind is live: it needs a session id to keep driving, which `start`
   * always pairs with a non-terminal step and `advance` always echoes back. */
  const applyStep = (
    sid: string | undefined,
    newStep: FlowStepViewData,
    toast: FlowToastViewData | undefined,
  ): void => {
    showToast(toast)
    setLiveStep(newStep)
    if (newStep.kind === "error") {
      notify({ tone: "error", message: newStep.message })
    }
    if (newStep.kind === "done" || newStep.kind === "error") {
      endSession()
      return
    }
    if (sid === undefined) return
    sessionRef.current = sid
    setSessionId(sid)
    if (newStep.kind === "await") {
      schedulePoll(sid, newStep.pollMs)
    } else {
      clearPoll()
    }
  }

  const advance = async (
    sid: string,
    result: FlowResultViewData,
  ): Promise<void> => {
    setBusy(true)
    const r = await client.advanceProviderFlow({ sessionId: sid, result })
    setBusy(false)
    if (!r.ok) {
      notify({ tone: "error", message: "Couldn't continue the setup flow" })
      endSession()
      return
    }
    // An absent `step` means nothing changed: a second advance raced the first (a
    // double-submit, or a poll racing a submit) and the runner refused it WITHOUT ending
    // the flow. Keep whatever step is already showing and keep polling if it was an
    // `await` — the in-flight call will deliver the real step.
    if (r.value.step === undefined) {
      showToast(r.value.toast)
      if (stepRef.current?.kind === "await") {
        schedulePoll(r.value.sessionId, stepRef.current.pollMs)
      }
      return
    }
    applyStep(r.value.sessionId, r.value.step, r.value.toast)
  }

  const start = async (input: StartProviderFlowInput): Promise<void> => {
    setBusy(true)
    const r = await client.startProviderFlow(input)
    setBusy(false)
    if (!r.ok) {
      notify({ tone: "error", message: "Couldn't start the setup flow" })
      return
    }
    applyStep(r.value.sessionId, r.value.step, r.value.toast)
  }

  const submit = async (
    values: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const sid = sessionRef.current
    if (sid === undefined) return
    await advance(sid, { kind: "form", values })
  }

  const ack = async (): Promise<void> => {
    const sid = sessionRef.current
    if (sid === undefined) return
    await advance(sid, { kind: "ack" })
  }

  const cancel = async (): Promise<void> => {
    const sid = sessionRef.current
    endSession()
    setLiveStep(undefined)
    if (sid !== undefined) {
      await client.cancelProviderFlow({ sessionId: sid })
    }
  }

  // Closing the modal (unmount) must stop a live flow instance — a supervised plugin
  // process keeps running until `cancelProviderFlow` is called. Only fires when a session
  // is still live: cancelling an already-finished (done/error) session is unnecessary,
  // though the IPC contract makes it harmless either way.
  // Runs once per mount: this hook drives exactly one flow session per mounted instance, and
  // the cleanup reads `sessionRef`/`client` fresh rather than needing them as dependencies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above the effect
  useEffect(() => {
    return () => {
      clearPoll()
      const sid = sessionRef.current
      if (sid !== undefined) {
        void client.cancelProviderFlow({ sessionId: sid })
      }
    }
  }, [])

  return { step, sessionId, busy, start, submit, ack, cancel }
}
