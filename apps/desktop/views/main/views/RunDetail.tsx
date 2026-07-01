import {
  type AttachmentCapabilities,
  type AttachmentKind,
  type AttachmentRef,
  type AttachmentRefWithBytes,
  type CanonicalEvent,
  type MessageItem,
  type RunState,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import type { HarnessId, ModelId, ModelRoute, SessionId } from "@spectrum/types"
import { Button, EmptyState, Lightbox, RunView, Spinner } from "@spectrum/ui"
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { useStore } from "zustand"
import { useIpcClient } from "../IpcClientContext"
import {
  type ComposerSeed,
  useComposerModeModel,
} from "../hooks/useComposerModeModel"
import { useElapsedSeconds } from "../hooks/useElapsedSeconds"
import { useNotifications } from "../hooks/useNotifications"
import { useStartWatchdog } from "../hooks/useStartWatchdog"
import { useTerminal } from "../hooks/useTerminal"
import { useUploads } from "../hooks/useUploads"
import type { RunnerClient } from "../runner/runnerClient"
import { useStores } from "../stores/createStores"
import { pendingToRender } from "../stores/outbox"
import type { OutboxEntry } from "../stores/outbox"
import type { TerminalClient } from "../terminal/terminalClient"

export const SEND_ACK_TIMEOUT_MS = 15_000

const EMPTY_OUTBOX: readonly OutboxEntry[] = []

/**
 * Fold a recorded backlog into a RunState, and extract the seed for the composer
 * mode/model from the first ROOT runner-started event (the one whose
 * parentRunnerId is undefined). `event.model` / `event.permissionMode` are not
 * projected into RunState by the reducer (they live only on the event envelope),
 * so replay must seed the store from the event itself.
 */
const foldRun = (
  events: ReadonlyArray<{ readonly event: CanonicalEvent }>,
): { readonly state: RunState; readonly seed: ComposerSeed | undefined } => {
  let state = initialRunState
  let seed: ComposerSeed | undefined
  for (const ev of events) {
    state = reduce(state, ev.event)
    if (
      seed === undefined &&
      ev.event.type === "runner-started" &&
      ev.event.parentRunnerId === undefined &&
      (ev.event.permissionMode !== undefined ||
        ev.event.model !== undefined ||
        ev.event.thinkingEffort !== undefined)
    ) {
      seed = {
        ...(ev.event.permissionMode !== undefined
          ? { mode: ev.event.permissionMode }
          : {}),
        ...(ev.event.model !== undefined ? { model: ev.event.model } : {}),
        ...(ev.event.thinkingEffort !== undefined
          ? { effort: ev.event.thinkingEffort }
          : {}),
      }
    }
  }
  return { state, seed }
}

export type RunDetailProps = {
  readonly mode: "live" | "replay"
  readonly sessionId: SessionId
  readonly runnerClient: RunnerClient
  /** The session's harness, used to persist per-harness composer prefs. Absent in replay. */
  readonly harnessId?: HarnessId
  /** All model routes, so the composer can render a picker. Absent = no picker. */
  readonly models?: readonly ModelRoute[]
  /** Map of providerId -> human name, used to label the model picker. */
  readonly providerNames?: Readonly<Record<string, string>>
  /**
   * Replay-mode only: the handler that turns a send from the (enabled) replay
   * composer into an auto-resume — the page flips the session open and asks
   * the manager to resume-and-send, so the backend replays the backlog itself.
   * The new `LiveRunDetail` suppresses its own `runnerClient.attach` for one
   * cycle (see `skipAttach`) so the socket doesn't double-replay.
   */
  readonly onResumeSend?: ((text: string) => void) | undefined
  /**
   * Live-mode only: the manager has already replayed the backlog via
   * `resumeAndSend`; suppress the `runnerClient.attach` so the socket
   * doesn't double-replay the history.
   */
  readonly skipAttach?: boolean
  /**
   * Terminal transport (over the dedicated terminal WebSocket). When absent,
   * the terminal pane + rail toggle are not wired up; existing tests that
   * never spawn a PTY keep passing.
   */
  readonly terminalClient?: TerminalClient
  /** Overrides the start-watchdog delays (defaults 3000/15000ms). Test-only. */
  readonly startWatchdog?: {
    readonly reattachDelayMs?: number
    readonly failDelayMs?: number
  }
}

/**
 * A `TerminalClient` whose methods are no-ops. Lets `RunDetail` call the
 * `useTerminal` hook unconditionally (rules-of-hooks safe) even when the
 * page hasn't plumbed a real transport — the hook then yields a controller
 * whose `paneOpen` stays `false`, so the pane never opens.
 */
const noopTerminalClient: TerminalClient = {
  open: () => {},
  attach: () => {},
  input: () => {},
  resize: () => {},
  close: () => {},
  dispatch: () => {},
  onOutput: () => () => {},
  onExited: () => () => {},
  onError: () => () => {},
  onOpened: () => () => {},
}

/** Live conversation: owns the runner socket attach + per-frame reduce. */
const LiveRunDetail = ({
  sessionId,
  runnerClient,
  harnessId,
  models,
  providerNames,
  skipAttach = false,
  terminalClient,
  startWatchdog,
}: {
  readonly sessionId: SessionId
  readonly runnerClient: RunnerClient
  readonly harnessId?: HarnessId
  readonly models?: readonly ModelRoute[]
  readonly providerNames?: Readonly<Record<string, string>>
  /**
   * True when the live view mounted because the replay composer sent a message and
   * the manager is about to resume+replay the backlog itself. Suppresses
   * `runnerClient.attach` so the socket doesn't double-replay.
   */
  readonly skipAttach?: boolean
  readonly terminalClient?: TerminalClient
  /** Overrides the start-watchdog delays (defaults 3000/15000ms). Test-only. */
  readonly startWatchdog?: {
    readonly reattachDelayMs?: number
    readonly failDelayMs?: number
  }
}): ReactElement => {
  const client = useIpcClient()
  const store = useStores().runView
  const runState = useStore(store, (s) => s.byId[sessionId])
  const openSubId = useStore(store, (s) => s.openSubBySession[sessionId])
  const busy = useStore(store, (s) => s.busyBySession[sessionId] ?? false)
  const elapsedSeconds = useElapsedSeconds(busy)
  const applyEvent = useStore(store, (s) => s.applyEvent)
  const openSub = useStore(store, (s) => s.openSub)
  const closeSub = useStore(store, (s) => s.closeSub)
  const resetRun = useStore(store, (s) => s.reset)

  const outbox = useStores().outbox
  const outboxEntries = useStore(
    outbox,
    (s) => s.bySession[sessionId] ?? EMPTY_OUTBOX,
  )
  const enqueueSend = useStore(outbox, (s) => s.enqueue)
  const reconcileOutbox = useStore(outbox, (s) => s.reconcile)
  const hydrateOutbox = useStore(outbox, (s) => s.hydrate)
  const markSendFailed = useStore(outbox, (s) => s.markFailed)
  const failAllSending = useStore(outbox, (s) => s.failAllSending)
  const removeSend = useStore(outbox, (s) => s.remove)

  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const { mode, onModeChange, model, onModelChange, effort, onEffortChange } =
    useComposerModeModel(
      sessionId,
      harnessId,
      undefined, // live: seeding flows through applyEvent, not the hook
      {
        setMode: (sid, m) => runnerClient.setMode(sid, m),
        setModel: (sid, id) =>
          runnerClient.setModel(sid, id === "" ? null : (id as ModelId)),
        setThinkingEffort: (sid, e) => runnerClient.setThinkingEffort(sid, e),
      },
    )

  // Wire the terminal controller. The hook needs `useTerminalStore` +
  // `useNotifications` provider scope (renderWithProviders mounts both) and a
  // `TerminalClient` transport. When the page hasn't plumbed a real socket
  // (e.g. in `RunDetail.test.tsx`) we pass a noop transport so the hook still
  // yields a stable controller; `paneOpen` stays false, so the pane never
  // renders and the rail button stays disabled.
  // Must run unconditionally before any early returns (rules of hooks).
  const terminal = useTerminal({
    sessionId,
    terminalClient: terminalClient ?? noopTerminalClient,
    ipcClient: client,
  })

  // Notifications + lightbox state. The page owns the open resolver and the
  // lightbox; `useUploads` defers to it (lightbox vs external-app dispatch).
  const { notify } = useNotifications()
  const [lightbox, setLightbox] = useState<
    | {
        readonly open: true
        readonly title: string
        readonly kind: AttachmentKind
        readonly dataUrl: string
      }
    | { readonly open: false }
  >({ open: false })

  const openAttachment = useCallback(
    async (ref: AttachmentRef, _dataUrl: string | null): Promise<void> => {
      // The hook doesn't pass a pre-resolved dataUrl — it just hands the ref
      // back to the page. We always re-read on open (lightbox / external-open
      // both need fresh bytes; the thumbnail is for the chip preview only).
      if (ref.kind === "image" || ref.kind === "text") {
        const r = await client.readUploadDataUrl({ id: ref.id, mime: ref.mime })
        if (r.ok && r.value.missing === true) {
          notify({ tone: "warning", message: "File no longer available" })
          return
        }
        if (r.ok && r.value.dataUrl !== undefined) {
          setLightbox({
            open: true,
            title: ref.displayName,
            kind: ref.kind,
            dataUrl: r.value.dataUrl,
          })
        }
        return
      }
      // pdf / binary → external viewer
      const r = await client.openUploadExternal({ id: ref.id })
      if (
        r.ok &&
        r.value !== null &&
        "missing" in r.value &&
        r.value.missing === true
      ) {
        notify({ tone: "warning", message: "File no longer available" })
      }
    },
    [client, notify],
  )

  // Register the per-session listener and attach once. The store accumulates the
  // RunState; this effect owns the only socket coupling on the page. `skipAttach`
  // suppresses the attach for the resumed session — the manager replays the backlog
  // in `resumeAndSend`, so the socket would otherwise double-replay.
  useEffect(() => {
    runnerClient.onEvent(sessionId, (e) => applyEvent(sessionId, e.event))
    if (!skipAttach) runnerClient.attach(sessionId)
  }, [sessionId, runnerClient, applyEvent, skipAttach])

  // Hydrate outbox from localStorage once per session (failSending restores crash-aborted entries).
  useEffect(() => {
    hydrateOutbox(sessionId)
  }, [sessionId, hydrateOutbox])

  const state = runState ?? initialRunState
  const root =
    state.rootRunnerId === undefined
      ? undefined
      : state.runners.get(state.rootRunnerId)

  const { failed: startFailed, retry: retryStart } = useStartWatchdog({
    active: root === undefined,
    reattach: () => {
      resetRun(sessionId)
      runnerClient.attach(sessionId)
    },
    ...(startWatchdog?.reattachDelayMs === undefined
      ? {}
      : { reattachDelayMs: startWatchdog.reattachDelayMs }),
    ...(startWatchdog?.failDelayMs === undefined
      ? {}
      : { failDelayMs: startWatchdog.failDelayMs }),
  })

  // Compute the set of clientSendIds that have landed in the reduced timeline
  // (safe before the root guard: empty set when root is not yet present).
  const presentIds = new Set(
    (root?.items ?? [])
      .filter(
        (i): i is MessageItem =>
          i.kind === "message" &&
          i.role === "user" &&
          i.clientSendId !== undefined,
      )
      .map((i) => i.clientSendId as string),
  )
  const pendingKey = [...presentIds].sort().join(",")
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingKey is the reconcile signal.
  useEffect(() => {
    reconcileOutbox(sessionId, presentIds)
    for (const id of presentIds) {
      const t = timers.current.get(id)
      if (t !== undefined) {
        clearTimeout(t)
        timers.current.delete(id)
      }
    }
  }, [sessionId, pendingKey, reconcileOutbox])

  // Subscribe to transport loss — flip all in-flight sends to failed.
  useEffect(() => {
    const off = runnerClient.onConnectionLost(() => failAllSending())
    return off
  }, [runnerClient, failAllSending])

  // Clear all pending timers on unmount.
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  const pending = pendingToRender(outboxEntries, presentIds)

  const handleInterrupt = (): void => {
    runnerClient.interrupt(sessionId)
    // Drop optimistic sends that never landed so their bubbles don't linger.
    for (const entry of outboxEntries) {
      if (entry.status === "sending") {
        const t = timers.current.get(entry.clientSendId)
        if (t !== undefined) {
          clearTimeout(t)
          timers.current.delete(entry.clientSendId)
        }
        removeSend(sessionId, entry.clientSendId)
      }
    }
  }

  // Page owns the pending list, picker call, lightbox state, and open resolver.
  // `uploads.open` defers back to `openAttachment` (it knows lightbox vs external).
  // `root` is set above; the hook accepts `undefined` until `runner-started` lands.
  const supportedAttachments: AttachmentCapabilities | undefined =
    root?.supportedAttachments
  const uploads = useUploads(supportedAttachments, openAttachment, notify)

  const handleSend = async (turn: {
    readonly text: string
    readonly attachments?: readonly AttachmentRef[]
  }): Promise<void> => {
    const text = turn.text
    const clientSendId = crypto.randomUUID()
    // Resolve dataUrls for the WebSocket Turn. `useUploads.resolveForSend`
    // silently drops refs whose dataUrl can't be read (file gone from disk) —
    // surface a toast so the user knows one of their attachments was dropped.
    const withBytes: AttachmentRefWithBytes[] = await uploads.resolveForSend()
    const pendingBefore = uploads.pending.length
    if (withBytes.length < pendingBefore) {
      notify({ tone: "warning", message: "File no longer available" })
    }
    const sendArgs: {
      readonly text: string
      readonly attachments?: AttachmentRefWithBytes[]
    } = {
      text,
      ...(withBytes.length > 0 ? { attachments: withBytes } : {}),
    }
    enqueueSend(sessionId, {
      clientSendId,
      text,
      status: "sending",
      ...(withBytes.length > 0 ? { attachments: uploads.pending } : {}),
    })
    runnerClient.send(sessionId, sendArgs, clientSendId)
    uploads.clear()
    const t = setTimeout(() => {
      markSendFailed(sessionId, clientSendId)
      timers.current.delete(clientSendId)
    }, SEND_ACK_TIMEOUT_MS)
    timers.current.set(clientSendId, t)
  }

  const [prefill, setPrefill] = useState<
    { readonly text: string; readonly key: string } | undefined
  >(undefined)
  const [dismissedErrorId, setDismissedErrorId] = useState<string | undefined>(
    undefined,
  )

  const handleResend = (entry: {
    readonly clientSendId?: string
    readonly text: string
  }): void => {
    if (entry.clientSendId !== undefined) {
      const t = timers.current.get(entry.clientSendId)
      if (t !== undefined) {
        clearTimeout(t)
        timers.current.delete(entry.clientSendId)
      }
      removeSend(sessionId, entry.clientSendId)
    }
    handleSend({ text: entry.text })
  }

  const handleCancel = (entry: {
    readonly clientSendId?: string
    readonly text: string
  }): void => {
    if (entry.clientSendId !== undefined) {
      const t = timers.current.get(entry.clientSendId)
      if (t !== undefined) {
        clearTimeout(t)
        timers.current.delete(entry.clientSendId)
      }
      removeSend(sessionId, entry.clientSendId)
    } else {
      // Provider-error message: persisted in run_events; dismiss its footer.
      const lastError = root?.items.findLast(
        (i): i is MessageItem => i.kind === "message" && i.tone === "error",
      )
      if (lastError !== undefined) setDismissedErrorId(lastError.messageId)
    }
    setPrefill({ text: entry.text, key: crypto.randomUUID() })
  }

  if (root === undefined)
    return startFailed ? (
      <div className="lk-start-failed">
        <EmptyState
          title="Couldn't start the agent"
          hint="The run didn't begin. Retry to reconnect and replay it."
        />
        <Button variant="secondary" onClick={retryStart}>
          Retry
        </Button>
      </div>
    ) : (
      <EmptyState title="Starting…" hint="Waiting for the agent to begin." />
    )

  const openRunner =
    openSubId === undefined ? undefined : state.runners.get(openSubId)
  const breadcrumb = [root.title ?? "main", openRunner?.title ?? "sub-runner"]

  return (
    <>
      <RunView
        root={root}
        runners={state.runners}
        {...(openRunner === undefined ? {} : { openRunner })}
        subBreadcrumb={breadcrumb}
        onOpenSubRunner={(rid) => openSub(sessionId, rid)}
        onCloseSub={() => closeSub(sessionId)}
        onSend={handleSend}
        onResend={handleResend}
        onCancel={handleCancel}
        {...(dismissedErrorId === undefined ? {} : { dismissedErrorId })}
        {...(prefill === undefined
          ? {}
          : { prefillText: prefill.text, prefillKey: prefill.key })}
        pending={pending}
        onDecide={(requestId, decision) =>
          runnerClient.approve(sessionId, requestId, decision)
        }
        onAnswer={(requestId, answer) =>
          runnerClient.answer(sessionId, requestId, answer)
        }
        onInterrupt={handleInterrupt}
        busy={busy}
        {...(elapsedSeconds === undefined ? {} : { elapsedSeconds })}
        mode={mode}
        onModeChange={onModeChange}
        model={model}
        {...(models === undefined ? {} : { models })}
        {...(providerNames === undefined ? {} : { providerNames })}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={onEffortChange}
        onOpenLink={(url) => {
          void client.openExternalUrl({ url })
        }}
        onOpenAttachment={(ref) => {
          void openAttachment(ref, null)
        }}
        {...(terminal === undefined ? {} : { terminal })}
        {...(supportedAttachments === undefined
          ? {}
          : { attachmentCapabilities: supportedAttachments })}
        pendingAttachments={uploads.pending}
        attachmentThumbnails={uploads.thumbnails}
        onPickAttachments={() => {
          void uploads.pick()
        }}
        onRemoveAttachment={uploads.remove}
        onDropFiles={(files) => {
          void uploads.addFiles(files)
        }}
      />
      <Lightbox
        open={lightbox.open}
        title={lightbox.open ? lightbox.title : ""}
        kind={lightbox.open ? lightbox.kind : "image"}
        {...(lightbox.open ? { dataUrl: lightbox.dataUrl } : {})}
        onClose={() => setLightbox({ open: false })}
      />
    </>
  )
}

/** Read-only replay: fold the stored events once; approvals inert, composer sends resume. */
const ReplayRunDetail = ({
  sessionId,
  harnessId,
  models,
  providerNames,
  onResumeSend,
}: {
  readonly sessionId: SessionId
  readonly harnessId?: HarnessId
  readonly models?: readonly ModelRoute[]
  readonly providerNames?: Readonly<Record<string, string>>
  readonly onResumeSend?: ((text: string) => void) | undefined
}): ReactElement => {
  const client = useIpcClient()
  const [folded, setFolded] = useState<
    | { readonly state: RunState; readonly seed: ComposerSeed | undefined }
    | undefined
  >(undefined)
  const [openSubId, setOpenSubId] =
    useState<RunState["rootRunnerId"]>(undefined)

  useEffect(() => {
    let active = true
    void client.getRunEvents({ id: sessionId }).then((r) => {
      if (!active || !r.ok) return
      setFolded(foldRun(r.value.events))
    })
    return () => {
      active = false
    }
  }, [client, sessionId])

  const { mode, onModeChange, model, onModelChange, effort, onEffortChange } =
    useComposerModeModel(
      sessionId,
      harnessId,
      folded?.seed,
      undefined, // no socket in replay; mode/model forward to the live session on resume-send
    )

  // Replay-mode attachment open: history chips can be reopened (the file is
  // still in `uploads/`), so the same open resolver applies. Replay has no
  // composer / no pending state, so we don't need `useUploads` here — only
  // the page-level resolver that reads the file and dispatches.
  const { notify: replayNotify } = useNotifications()
  const [replayLightbox, setReplayLightbox] = useState<
    | {
        readonly open: true
        readonly title: string
        readonly kind: AttachmentKind
        readonly dataUrl: string
      }
    | { readonly open: false }
  >({ open: false })

  const replayOpenAttachment = useCallback(
    async (ref: AttachmentRef, _dataUrl: string | null): Promise<void> => {
      if (ref.kind === "image" || ref.kind === "text") {
        const r = await client.readUploadDataUrl({ id: ref.id, mime: ref.mime })
        if (r.ok && r.value.missing === true) {
          replayNotify({ tone: "warning", message: "File no longer available" })
          return
        }
        if (r.ok && r.value.dataUrl !== undefined) {
          setReplayLightbox({
            open: true,
            title: ref.displayName,
            kind: ref.kind,
            dataUrl: r.value.dataUrl,
          })
        }
        return
      }
      const r = await client.openUploadExternal({ id: ref.id })
      if (
        r.ok &&
        r.value !== null &&
        "missing" in r.value &&
        r.value.missing === true
      ) {
        replayNotify({ tone: "warning", message: "File no longer available" })
      }
    },
    [client, replayNotify],
  )

  if (folded === undefined) return <Spinner label="Loading conversation" />
  const { state } = folded
  // seed already applied via the hook's effect
  void folded.seed
  const root =
    state.rootRunnerId === undefined
      ? undefined
      : state.runners.get(state.rootRunnerId)
  if (root === undefined)
    return (
      <EmptyState
        title="No recorded conversation"
        hint="This session has no captured agent events."
      />
    )
  const openRunner =
    openSubId === undefined ? undefined : state.runners.get(openSubId)
  const breadcrumb = [root.title ?? "main", openRunner?.title ?? "sub-runner"]

  // Replay-mode send → the page adds the session to `openSessionIds` and asks the
  // manager to resume+send. The page-level `onResumeSend` is the bridge; if it's
  // absent (e.g. a test harness) the composer stays inert via the fallback handler.
  const handleSend = (turn: { text: string }): void => {
    onResumeSend?.(turn.text)
  }

  return (
    <>
      <RunView
        root={root}
        runners={state.runners}
        {...(openRunner === undefined ? {} : { openRunner })}
        subBreadcrumb={breadcrumb}
        onOpenSubRunner={(rid) => setOpenSubId(rid)}
        onCloseSub={() => setOpenSubId(undefined)}
        onSend={handleSend}
        onDecide={() => {}}
        onAnswer={() => {}}
        inert
        composerDisabled={onResumeSend === undefined}
        mode={mode}
        onModeChange={onModeChange}
        model={model}
        {...(models === undefined ? {} : { models })}
        {...(providerNames === undefined ? {} : { providerNames })}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={onEffortChange}
        onOpenLink={(url) => {
          void client.openExternalUrl({ url })
        }}
        onOpenAttachment={(ref) => {
          void replayOpenAttachment(ref, null)
        }}
      />
      <Lightbox
        open={replayLightbox.open}
        title={replayLightbox.open ? replayLightbox.title : ""}
        kind={replayLightbox.open ? replayLightbox.kind : "image"}
        {...(replayLightbox.open ? { dataUrl: replayLightbox.dataUrl } : {})}
        onClose={() => setReplayLightbox({ open: false })}
      />
    </>
  )
}

/**
 * The native conversation detail. `RunDetail` owns ALL data: live mode connects
 * the runner WS client (attach + reduce each frame into `runViewStore`); replay
 * mode folds `getRunEvents` once and renders read-only. The dumb `RunView` only
 * receives props.
 */
export const RunDetail = ({
  mode,
  sessionId,
  runnerClient,
  harnessId,
  models,
  providerNames,
  onResumeSend,
  skipAttach = false,
  terminalClient,
  startWatchdog,
}: RunDetailProps): ReactElement =>
  mode === "live" ? (
    <LiveRunDetail
      sessionId={sessionId}
      runnerClient={runnerClient}
      {...(harnessId === undefined ? {} : { harnessId })}
      {...(models === undefined ? {} : { models })}
      {...(providerNames === undefined ? {} : { providerNames })}
      skipAttach={skipAttach}
      {...(terminalClient === undefined ? {} : { terminalClient })}
      {...(startWatchdog === undefined ? {} : { startWatchdog })}
    />
  ) : (
    <ReplayRunDetail
      sessionId={sessionId}
      {...(harnessId === undefined ? {} : { harnessId })}
      {...(onResumeSend === undefined ? {} : { onResumeSend })}
      {...(models === undefined ? {} : { models })}
      {...(providerNames === undefined ? {} : { providerNames })}
    />
  )
