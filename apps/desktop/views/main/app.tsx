import {
  type RootRunnerMap,
  isRootRunnerFinished,
  trackRootRunner,
} from "@spectrum/agent-events"
import type { IpcClient, IpcError } from "@spectrum/ipc"
import type { ProjectId, SessionId } from "@spectrum/types"
import {
  type AppMode,
  AppShell,
  NewSessionModal,
  ToastContainer,
} from "@spectrum/ui"
import type { NewSessionValues } from "@spectrum/ui"
import {
  type ReactElement,
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { createRoot } from "react-dom/client"
import { useStore } from "zustand"
import { IpcClientProvider, useIpcClient } from "./IpcClientContext"
import { LoggerProvider } from "./LoggerContext"
import { createRealClients } from "./clients"
import { ConnectionLostOverlay } from "./components/ConnectionLostOverlay"
import { MountFallback } from "./components/MountFallback"
import { UpdateBanner } from "./components/UpdateBanner"
import { useConnectionWatch } from "./hooks/useConnectionWatch"
import { useHarnesses } from "./hooks/useHarnesses"
import { useModels } from "./hooks/useModels"
import { useNotifications } from "./hooks/useNotifications"
import { useProjects } from "./hooks/useProjects"
import { useProviders } from "./hooks/useProviders"
import { useProxyStatus } from "./hooks/useProxyStatus"
import { useUpdate } from "./hooks/useUpdate"
import { createWebviewLogger } from "./logger"
import type { RunnerClient } from "./runner/runnerClient"
import { StoreProvider, useStores } from "./stores/createStores"
import { type LocationAdapter, windowLocationAdapter } from "./stores/location"
import { encodeView } from "./stores/uiStore"
import type { TerminalClient } from "./terminal/terminalClient"
import type { UpdateClient } from "./update/updateClient"
import { SessionsView } from "./views/SessionsView"
import { SettingsView } from "./views/SettingsView"
import { withTimeout } from "./withTimeout"

export type { View } from "./stores/uiStore"

/**
 * Derive a readable, message-safe string from an `IpcError` for the modal alert.
 * Uses the typed `detail` (the only message-bearing field — no stack/secrets),
 * falling back to the `kind` when a handler returned no detail.
 */
const ipcErrorMessage = (prefix: string, error: IpcError): string =>
  error.detail.trim() === ""
    ? `${prefix} (${error.kind}).`
    : `${prefix}: ${error.detail}`

export type AppProps = {
  readonly client: IpcClient
  /** The initial view, as a raw hash string (e.g. `settings/providers`). */
  readonly initialView?: string
  /**
   * The runner transport client for native harness sessions. Injected so tests
   * run without a real WebSocket; production builds the real one via
   * `createRealClients` in `clients.ts`.
   */
  readonly runnerClient: RunnerClient
  /**
   * The terminal transport client for the in-app PTY panel. Optional so the
   * existing test render sites don't need a stub socket; production wires a
   * real WS client via `createRealClients` in `clients.ts`.
   */
  readonly terminalClient?: TerminalClient
  /**
   * The update push client for receiving server-pushed UpdateState frames over
   * a dedicated loopback WebSocket. Required — production supplies a real WS
   * client via `createRealClients`; tests supply a `createUpdateClient()` stub.
   */
  readonly updateClient: UpdateClient
  /** Injected so the hash-sync effect is testable; defaults to window. */
  readonly location?: LocationAdapter
}

/** Props for the data-aware inner shell (rendered inside `IpcClientProvider`). */
type AppInnerProps = {
  readonly location: LocationAdapter
  readonly runnerClient: RunnerClient
  readonly terminalClient?: TerminalClient
}

/**
 * The stateful app body. Split out from `App` so its IPC hooks (e.g.
 * `useProxyStatus`) and the view factories' hooks all run INSIDE the
 * `IpcClientProvider` that `App` mounts.
 */
const AppInner = ({
  location,
  runnerClient,
  terminalClient,
}: AppInnerProps): ReactElement => {
  const client = useIpcClient()
  // After a sleep gap, verify the backend is reachable; if not, self-reload to
  // re-establish the (non-reconnecting) Electrobun RPC + runner socket. Uses the
  // cheap getProxyStatus as the liveness ping. Date.now is the wall clock here by
  // design — the hook keys off real elapsed time, which is exactly the wake signal.
  const pingBackend = useCallback(
    () => client.getProxyStatus(undefined).then((r) => r.ok),
    [client],
  )
  const reloadWebview = useCallback(() => window.location.reload(), [])
  const nowMs = useCallback(() => Date.now(), [])
  const conn = useConnectionWatch({
    ping: pingBackend,
    onLost: reloadWebview,
    now: nowMs,
  })
  const uiStore = useStores().ui
  const view = useStore(uiStore, (s) => s.view)
  const openSessionIds = useStore(uiStore, (s) => s.openSessionIds)
  const modalOpen = useStore(uiStore, (s) => s.modalOpen)
  const navigate = useStore(uiStore, (s) => s.navigate)
  const openSession = useStore(uiStore, (s) => s.openSession)
  const setModalOpen = useStore(uiStore, (s) => s.setModalOpen)
  // A launch failure to surface inside the modal (so the user isn't left staring
  // at a silently-failed "New session"). Cleared when the modal (re)opens, on
  // cancel, and on a successful launch.
  const [launchError, setLaunchError] = useState<string | undefined>(undefined)
  // The cwd picked via the native folder dialog (fed into NewSessionModal).
  const [folder, setFolder] = useState<string>("")
  // The last harness launched, used to preselect the modal's select. The
  // composer's model selector persists per-harness directly (no modal state).
  const [initialHarnessId, setInitialHarnessId] = useState<string>("")
  /**
   * Sessions whose just-resumed live view must NOT call `runnerClient.attach`
   * on mount — the manager has already replayed the backlog via `resumeAndSend`,
   * and a re-attach would cause the history to be replayed a second time.
   * STICKY for the resumed session's lifetime: the flag stays set until the
   * user explicitly closes the session (removes it from `openSessionIds`).
   * Live events for a resumed session are NOT a signal to clear it — the
   * manager owns the replay and continues to stream the same socket, so any
   * future re-mount of `LiveRunDetail` must still skip attach to avoid the
   * double-replay.
   */
  const [skipAttachIds, setSkipAttachIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const proxy = useProxyStatus()
  const update = useUpdate()
  const notifications = useNotifications()
  // Live turn-in-flight per session — drives the master row's running badge.
  // Read from `runViewStore` (the same store `LiveRunDetail` writes to).
  const busyBySession = useStore(useStores().runView, (s) => s.busyBySession)
  // `applyEvent` is exposed so the firehose effect (below) can keep the
  // runViewStore in sync regardless of whether the per-session listener on
  // `LiveRunDetail` is registered yet — defense-in-depth against the
  // race where the manager replays before the webview mounts.
  const applyEvent = useStore(useStores().runView, (s) => s.applyEvent)

  // Prefill the New Session modal with the last launched folder/harness
  // (persisted by a successful launch). Page-level fetch — the modal stays dumb
  // and just receives the resolved props.
  useEffect(() => {
    let active = true
    void client.getSettings(undefined).then((r) => {
      if (!active || !r.ok) return
      if (r.value.lastSelectedFolder !== "")
        setFolder(r.value.lastSelectedFolder)
      if (r.value.lastSelectedHarnessId !== "")
        setInitialHarnessId(r.value.lastSelectedHarnessId)
    })
    return () => {
      active = false
    }
  }, [client])

  // The projects/sessions list lives here (not inside SessionsView) so a launch
  // can refetch it: a new running session must appear in the right project group.
  const projectsView = useProjects()

  // Feed the new-session modal. These hooks load lazily and stay cheap when the
  // modal is closed (the data is just handed to a dumb component).
  const harnesses = useHarnesses()
  const models = useModels()
  const providers = useProviders()

  const providerNames: Record<string, string> = {}
  for (const p of providers.data ?? []) providerNames[p.id] = p.name

  // Keep the URL hash in sync so reloads land on the same view (no remote nav).
  useEffect(() => {
    location.writeHash(encodeView(view))
  }, [view, location])

  // Track each session's ROOT runner (the first parentless `runner-started`) across the firehose.
  // A multi-agent run emits one `runner-finished` per runner — sub-agents AND the root — so we must
  // toast ONLY on the root finish, never mid-run on a sub-agent. A ref (not state) survives the
  // effect re-subscription below (which re-runs on `view` change) so accumulated roots are retained.
  const rootsRef = useRef<RootRunnerMap>(new Map())

  // `notify` is a referentially STABLE zustand store action (its identity never changes), unlike the
  // `notifications` object literal which is fresh each render. Depend on `notify` below so the effect
  // re-subscribes only on intended changes (view/runnerClient/navigate), not on every re-render.
  const notify = notifications.notify

  // Live session-name pushes (auto-derived/harness title mid-run). Updates the cached
  // session in place; the persisted name is the source of truth and is already written by the
  // RunManager. No toast — this is a quiet background refresh of the list.
  const updateSessionName = projectsView.updateSessionName
  useEffect(() => {
    const off = runnerClient.onSessionRenamed((id, name) => {
      updateSessionName(id, name)
    })
    return off
  }, [runnerClient, updateSessionName])

  // Fresh-restart toast: the manager emits `session-resume-token` with an empty
  // `resumeToken` when the resumed row has no resumable history. Surface this as
  // a one-time info toast so the user knows the conversation started over.
  useEffect(() => {
    const off = runnerClient.onResumeToken((_id, resumeToken) => {
      if (resumeToken !== "") return
      notify({
        tone: "info",
        message: "Restarted fresh — this harness can't resume history.",
      })
    })
    return off
  }, [runnerClient, notify])

  // Toast when a BACKGROUND run finishes/errors (not the session being viewed).
  // `onAny` accumulates listeners, so the effect MUST drop its previous one via
  // the returned unsubscribe fn on every re-run — otherwise toasts would stack.
  // The firehose ALSO drives the runViewStore via `applyEvent` — the per-session
  // listener on `LiveRunDetail` covers the common case, but if the manager replays
  // a stored event before the webview's listener is registered, the events would
  // be lost. Calling `applyEvent` here guarantees the store reflects every frame.
  useEffect(() => {
    const off = runnerClient.onAny((id, stored) => {
      const ev = stored.event
      applyEvent(id, ev)
      // Update the root map on EVERY frame so a later runner-finished can be classified.
      rootsRef.current = trackRootRunner(rootsRef.current, id, ev)
      if (ev.type !== "runner-finished") return
      if (ev.status === "interrupted") return
      // Fail-closed: suppress unless this finish is for the session's recorded ROOT runner.
      if (!isRootRunnerFinished(rootsRef.current, id, ev)) return
      const isViewing =
        view.kind === "sessions" && view.selectedSessionId === id
      if (isViewing) return
      const action = {
        label: "View",
        onClick: () => navigate({ kind: "sessions", selectedSessionId: id }),
      }
      notify(
        ev.status === "errored"
          ? { tone: "error", message: "A run failed", action }
          : { tone: "info", message: "A run finished", action },
      )
    })
    return off
  }, [runnerClient, view, notify, navigate, applyEvent])

  const mode: AppMode = view.kind === "settings" ? "settings" : "sessions"

  const onModeChange = (next: AppMode): void =>
    navigate(
      next === "settings"
        ? { kind: "settings", section: "general" }
        : { kind: "sessions" },
    )

  const onBrowse = async (): Promise<void> => {
    const r = await client.pickFolder({})
    if (!r.ok) {
      setLaunchError(
        ipcErrorMessage("Couldn't open the folder picker", r.error),
      )
      return
    }
    if (r.value.path !== undefined && r.value.path !== "")
      setFolder(r.value.path)
  }

  const onSubmitNewSession = async (v: NewSessionValues): Promise<void> => {
    // Omit empty name/cwd so they're never sent as "" — the IPC `name` schema
    // accepts "" but a session created with name:"" then fails SessionSchema's
    // min(1) on the next getSessions, and an empty cwd is meaningless.
    // Model selection lives in the composer (per-harness prefs); the modal does
    // not carry a model id.
    const r = await projectsView.launch({
      id: v.harnessId,
      ...(v.name !== undefined && v.name.trim() !== "" ? { name: v.name } : {}),
      ...(v.cwd.trim() ? { cwd: v.cwd } : {}),
      env: v.env,
    })
    if (!r.ok) {
      // Surface the failure in the modal (keep it open) instead of swallowing it.
      setLaunchError(ipcErrorMessage("Could not launch session", r.error))
      return
    }
    setLaunchError(undefined)
    const id = r.value.sessionId
    openSession(id)
    navigate({ kind: "sessions", selectedSessionId: id })
    setModalOpen(false)
    // sessions.launch already invalidates both groups on success.
  }

  // Replay-composer send: flip replay→live (so the new `LiveRunDetail` mounts)
  // and forward the text via `runnerClient.send`. The manager treats `run-send`
  // for an unknown/ended session id as an auto-resume: it relaunches the
  // harness with the session's `resumeId` and replays the backlog itself. The
  // `skipAttach` flag suppresses the new `LiveRunDetail`'s own `run-attach` so
  // the history is replayed exactly once.
  const onResumeSend = (sessionId: SessionId, text: string): void => {
    setSkipAttachIds((prev) => {
      const next = new Set(prev)
      next.add(String(sessionId))
      return next
    })
    openSession(sessionId)
    runnerClient.send(sessionId, text)
  }

  // Garbage-collect the sticky `skipAttach` flag: when a session is no longer
  // in `openSessionIds`, it was closed (or removed), so a future re-mount of
  // `LiveRunDetail` (e.g. after re-opening via `onResumeSend`) must set the
  // flag again from scratch. We clear stale entries on every change to the
  // open-set so the set never grows unbounded.
  const openIdStrings = openSessionIds.map((id) => String(id)).join("|")
  useEffect(() => {
    setSkipAttachIds((prev) => {
      if (prev.size === 0) return prev
      const open = new Set(openIdStrings.split("|").filter((s) => s !== ""))
      let changed = false
      const next = new Set<string>()
      for (const id of prev)
        if (open.has(id)) next.add(id)
        else changed = true
      return changed ? next : prev
    })
  }, [openIdStrings])

  const { master, detail } =
    view.kind === "settings"
      ? SettingsView({
          section: view.section,
          onSection: (key) => navigate({ kind: "settings", section: key }),
        })
      : SessionsView({
          ...(view.selectedSessionId === undefined
            ? {}
            : { selectedSessionId: view.selectedSessionId }),
          openSessionIds,
          projects: projectsView.projects,
          sessionsByProject: projectsView.sessionsByProject,
          collapsed: projectsView.collapsed,
          allSessions: projectsView.allSessions,
          onToggle: projectsView.toggleCollapse,
          onMore: projectsView.loadMore,
          onSelect: (id) =>
            navigate({ kind: "sessions", selectedSessionId: id }),
          onNew: () => {
            harnesses.refetch()
            models.refetch()
            providers.refetch()
            setLaunchError(undefined)
            setModalOpen(true)
          },
          onDeleteProject: (projectId) => {
            // If the selected session belonged to this project it simply
            // vanishes from the refetched lists; SessionsDetail already renders
            // the empty state when the session isn't found, so no extra
            // selection handling is needed here.
            void (async () => {
              const r = await projectsView.deleteProject(projectId as ProjectId)
              if (r.ok)
                notifications.notify({
                  tone: "success",
                  message: "Project deleted",
                })
              else
                notifications.notify({
                  tone: "error",
                  message: "Couldn't delete the project",
                  action: {
                    label: "Retry",
                    onClick: () =>
                      void projectsView.deleteProject(projectId as ProjectId),
                  },
                })
            })()
          },
          onDeleteSession: (sessionId) => {
            void (async () => {
              const r = await projectsView.deleteSession(sessionId)
              if (r.ok) {
                notifications.notify({
                  tone: "success",
                  message: "Session deleted",
                })
                // If the open detail pane was showing this session, drop the selection.
                if (
                  view.kind === "sessions" &&
                  view.selectedSessionId === sessionId
                )
                  navigate({ kind: "sessions" })
              } else {
                notifications.notify({
                  tone: "error",
                  message: "Couldn't delete the session",
                  action: {
                    label: "Retry",
                    onClick: () => void projectsView.deleteSession(sessionId),
                  },
                })
              }
            })()
          },
          onRename: (id, name) => {
            void (async () => {
              const r = await projectsView.renameSession(id, name)
              if (!r.ok)
                notifications.notify({
                  tone: "error",
                  message: "Could not rename session",
                })
            })()
          },
          runnerClient,
          models: models.data ?? [],
          providerNames,
          busyBySession,
          onResumeSend,
          skipAttachIds,
          ...(terminalClient === undefined ? {} : { terminalClient }),
        })

  return (
    <>
      <UpdateBanner
        state={update.state}
        onDownload={update.download}
        onRestart={update.apply}
        onDismiss={update.dismiss}
      />
      <ToastContainer
        notifications={notifications.notifications}
        onDismiss={notifications.dismiss}
      />
      {conn.lost ? <ConnectionLostOverlay /> : null}
      <AppShell
        mode={mode}
        onModeChange={onModeChange}
        proxyRunning={proxy.data?.running ?? false}
        proxyPort={proxy.data?.port}
        master={master}
        detail={detail}
      />
      <NewSessionModal
        open={modalOpen}
        harnesses={harnesses.data ?? []}
        folder={folder}
        initialHarnessId={initialHarnessId}
        {...(launchError === undefined ? {} : { error: launchError })}
        onBrowse={() => void onBrowse()}
        onSubmit={(v) => void onSubmitNewSession(v)}
        onCancel={() => {
          setLaunchError(undefined)
          setModalOpen(false)
        }}
      />
    </>
  )
}

export const App = ({
  client,
  initialView = "sessions",
  runnerClient,
  terminalClient,
  updateClient,
  location = windowLocationAdapter,
}: AppProps): ReactElement => {
  const log = createWebviewLogger({ forward: (p) => client.logClientError(p) })
  return (
    <IpcClientProvider client={client}>
      <LoggerProvider logger={log}>
        <StoreProvider
          client={client}
          initialView={initialView}
          updateClient={updateClient}
        >
          <AppInner
            runnerClient={runnerClient}
            {...(terminalClient === undefined ? {} : { terminalClient })}
            location={location}
          />
        </StoreProvider>
      </LoggerProvider>
    </IpcClientProvider>
  )
}

/** Production entry: build the Electrobun-backed client and mount into #root. */
export const mount = async (): Promise<void> => {
  const container = document.getElementById("root")
  if (container === null) throw new Error("missing #root element")
  const root = createRoot(container)
  try {
    const startView = window.location.hash.replace(/^#/, "")
    // Bound the startup IPC: a wedged Electrobun RPC must surface a fallback, not hang blank.
    const { ipcClient, runnerClient, terminalClient, updateClient } =
      await withTimeout(createRealClients(), 10000, "client init")
    root.render(
      <StrictMode>
        <App
          client={ipcClient}
          runnerClient={runnerClient}
          terminalClient={terminalClient}
          updateClient={updateClient}
          initialView={startView}
        />
      </StrictMode>,
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected startup error."
    root.render(
      <MountFallback
        message={message}
        onReload={() => window.location.reload()}
      />,
    )
  }
}

// Auto-mount only in the real webview (a DOM with #root), never under the test
// runner (which imports `App` directly and renders it with a fake client).
if (
  typeof document !== "undefined" &&
  document.getElementById("root") !== null
) {
  void mount()
}
