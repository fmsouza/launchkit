/**
 * The GUI composition seam. `createGuiContext(shared, deps)` extends the SHARED
 * `AppContext` (built by `@spectrum/runtime-core`'s `createAppContext`) with
 * the GUI-only pieces: the native run manager, the loopback runner socket,
 * the renderer watchdog, the updater, the native folder picker, the URL
 * opener, and the factory-reset routine.
 *
 * What lives here (and ONLY here):
 * - Construction of the GUI seams (`createRunManager`, `startRunnerSocket`,
 *   `createRendererWatchdog`, `createElectrobunUpdater`, `createResetApp`).
 * - The native run-finished notification pipeline (`createNotificationService`
 *   + `withNotifierTap` + root-runner gating).
 * - Lazy native imports (`electrobun/bun` for folder picker / URL opener /
 *   `pickFolder` / `openExternalUrl`) so `bun test` never loads native FFI.
 *
 * What DOES NOT live here:
 * - Any shared subsystem wiring — that moved to `@spectrum/runtime-core` in
 *   the Stage 1 refactor (Tasks 1-4). The CLI and the GUI both consume
 *   `createAppContext`; only the GUI wraps it with `createGuiContext`.
 *
 * End-state: composition.ts is GUI-only. The CLI lives in `apps/cli/`, which
 * imports `createAppContext` directly from `@spectrum/runtime-core` (no
 * `createGuiContext`, no `detectMode`, no `runApp`). The dual-mode routing
 * (detectMode + runApp + runCli) was removed in Stage 2 Task 8; this file
 * is no longer the composition root for the whole binary.
 */

// Re-exports from the shared composition root so existing
// `import type { AppContext } from "../composition"` keeps resolving in gui/*.
export type {
  AppContext,
  CreateAppContextDeps,
  ProviderTestResult,
} from "@spectrum/runtime-core"
export { createAppContext } from "@spectrum/runtime-core"
import { realDeps as runtimeCoreRealDeps } from "@spectrum/runtime-core"
import { createFsUploadStore } from "./upload-store-fs"

/**
 * Desktop-flavored `realDeps`: the shared runtime-core wiring with the real fs-backed
 * `createUploadStore` (`createFsUploadStore` over `paths.uploadsDir`) so the GUI can
 * actually persist user-picked attachments. Headless consumers (CLI) keep the runtime-core
 * default (in-memory stub) and never see this.
 */
export const realDeps = {
  ...runtimeCoreRealDeps,
  createUploadStore: ({ uploadsDir }: { readonly uploadsDir: string }) =>
    createFsUploadStore({ uploadsDir }),
} as const

import { rmSync } from "node:fs"
import { homedir } from "node:os"

import type {
  AgentDriver,
  NameGeneratorPort,
  RunManager,
  RunManagerDeps,
  RunnerOutbound,
} from "@spectrum/agent-driver"
import { createRunManager } from "@spectrum/agent-driver"
import type { RootRunnerMap } from "@spectrum/agent-events"
import { isRootRunnerFinished, trackRootRunner } from "@spectrum/agent-events"
import type { Logger } from "@spectrum/logger"
import { createNameGenerator } from "@spectrum/proxy"
import {
  type TerminalManager,
  checkNativePtyAvailable,
  createBunFfiPtySpawner,
  createNoopTerminalManager,
  createTerminalManager,
} from "@spectrum/pty"
import type { ModelId, ProjectId, SessionId } from "@spectrum/types"
import { type Result, isOk } from "@spectrum/utils"

import type { AppContext } from "@spectrum/runtime-core"
import { createNotificationService } from "./gui/notification-service"
import { defaultRelaunch } from "./gui/relaunch"
import {
  type RendererWatchdog,
  createRendererWatchdog,
  realWatchdogTimers,
} from "./gui/renderer-watchdog"
import { type ResetError, createResetApp } from "./gui/reset-app"
import { enrichGuiPathAsync } from "./gui/resolve-path"
import {
  type SessionInfoResolver,
  mapRunFinished,
} from "./gui/run-finished-mapping"
import { withNotifierTap } from "./gui/runner-sink"
import { type RunnerSocket, startRunnerSocket } from "./gui/runner-socket"
import { type TerminalSocket, startTerminalSocket } from "./gui/terminal-socket"
import { type UpdateSocket, startUpdateSocket } from "./gui/update-socket"
import { buildUpdateState } from "./gui/updater/build-update-state"
import { createElectrobunUpdater } from "./gui/updater/electrobun-updater"
import {
  type PollerTimers,
  UPDATE_POLL_INTERVAL_MS,
  createUpdatePoller,
  realPollerTimers,
} from "./gui/updater/update-poller"
import type { UpdaterAdapter } from "./gui/updater/updater-adapter"
import { isWindowFocused } from "./gui/window"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The GUI-extended context: every shared field from `AppContext` plus the
 * 7 GUI-only fields the renderer and IPC handlers consume.
 */
export interface GuiContext extends AppContext {
  readonly runner: RunManager
  /** `ws://localhost:<port>/` the webview connects to for canonical run events. */
  readonly runnerSocketUrl: string
  readonly rendererWatchdog: RendererWatchdog
  readonly resetApp: () => Promise<Result<void, ResetError>>
  readonly pickFolder: (opts: { readonly startingFolder?: string }) => Promise<
    readonly string[]
  >
  readonly openExternalUrl: (url: string) => Promise<boolean>
  readonly updater: UpdaterAdapter
  /** In-app terminal PTY manager (terminal-panel plan). */
  readonly terminalManager: TerminalManager
  /** `ws://localhost:<port>/` the webview connects to for the terminal byte stream. */
  readonly terminalSocketUrl: string
  /** `ws://localhost:<port>/` the webview connects to for pushed UpdateState frames. */
  readonly updateSocketUrl: string
  /** Re-check the feed + push the fresh UpdateState to the update socket. Used by the poller + IPC handlers. */
  readonly pushUpdateState: () => Promise<void>
  /**
   * Resolve a session's raw DB row (`cwd`, `projectId`) for the terminal cwd resolver. Returns
   * `undefined` when the session id is unknown. The public `Session` type drops `projectId`,
   * so the GUI composes this on top of the row type so the IPC handler can look up the project.
   */
  readonly resolveSessionRow: (sessionId: SessionId) => Promise<
    | {
        readonly cwd: string | undefined
        readonly projectId: string | undefined
      }
    | undefined
  >
  /** Resolve a project id (plain string) to its absolute path, or `undefined` when unknown. */
  readonly resolveProjectPath: (
    projectId: string,
  ) => Promise<string | undefined>
  /** Cached at construction: `os.homedir()`. */
  readonly homeDir: string
  /**
   * Await the deferred GUI PATH enrichment (memoized; resolves immediately if already settled).
   * The harness-launch path MUST await this before `ctx.runner.launch(...)` so the deferred
   * login-shell PATH probe has settled by the time `Bun.which(command, { PATH })` runs.
   * Threaded from `RunGuiDeps.ensureGuiPathResolved` via `buildRealDeps` in `main.ts`.
   */
  readonly ensureGuiPathResolved: () => Promise<void>
}

/**
 * The 8 GUI seams `createGuiContext` injects. Defaulted to the real adapters
 * in `realGuiDeps`; tests inject fakes to exercise wiring shape without
 * loading native FFI / opening sockets.
 */
export interface CreateGuiContextDeps {
  readonly createRunManager: typeof createRunManager
  readonly startRunnerSocket: typeof startRunnerSocket
  readonly startTerminalSocket: typeof startTerminalSocket
  readonly startUpdateSocket: typeof startUpdateSocket
  readonly createRendererWatchdog: typeof createRendererWatchdog
  /** Recursively remove a directory (factory reset). */
  readonly removeDir: (dir: string) => void
  /** Relaunch the app process (Electrobun). Defaulted to a lazy native call. */
  readonly relaunch: () => void
  /** Poller timers — injected so tests don't start a real 3-min interval. */
  readonly pollerTimers: PollerTimers
  /**
   * Await the deferred GUI PATH enrichment. The harness-launch path (IPC `launchHarness` +
   * tray Launch) reads this through `ctx.ensureGuiPathResolved()` BEFORE `ctx.runner.launch(...)`
   * to guarantee the deferred PATH probe has settled by the time a harness command is resolved.
   * Defaulted to the real `enrichGuiPathAsync()` in `realGuiDeps`; tests inject a recording stub.
   */
  readonly ensureGuiPathResolved: () => Promise<void>
}

// ---------------------------------------------------------------------------
// realGuiDeps — production wiring
// ---------------------------------------------------------------------------

/** Recursive directory removal (factory reset). */
const defaultRemoveDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true })
}

/** Production defaults for the GUI seams. */
export const realGuiDeps: CreateGuiContextDeps = {
  createRunManager,
  startRunnerSocket,
  startTerminalSocket,
  startUpdateSocket,
  createRendererWatchdog,
  removeDir: defaultRemoveDir,
  relaunch: defaultRelaunch,
  pollerTimers: realPollerTimers,
  // The real seam awaits the deferred (memoized) GUI PATH enrichment. The probe is already
  // fired in `main.ts`'s `startProxy`; awaiting here is what guarantees the probe has settled
  // by the time a harness command is resolved on the IPC `launchHarness` / tray Launch paths.
  ensureGuiPathResolved: async () => {
    await enrichGuiPathAsync()
  },
}

// ---------------------------------------------------------------------------
// createGuiContext
// ---------------------------------------------------------------------------

/**
 * Build the GUI context: consume the shared `AppContext` (built by
 * `@spectrum/runtime-core`'s `createAppContext`) and construct the 7
 * GUI-only fields from the runner extension points + the injected seams.
 *
 * The runner extension points (`sessionSink`, `runStore`, `routingDriver`,
 * `resolveResumeInput`, `resolveModelEnv`) come from `shared` — the GUI
 * never re-derives them. `dataDir` and `legacyDirs` likewise come from
 * `shared` (exposed on `AppContext.paths.dataDir` + `AppContext.legacyDirs`
 * since Task 2/4).
 */
export const createGuiContext = (
  shared: AppContext,
  deps: CreateGuiContextDeps = realGuiDeps,
): GuiContext => {
  const log: Logger = shared.log

  // ------------------------------------------------------------------
  // Native run-finished notification pipeline
  // ------------------------------------------------------------------
  //
  // Root-gating: a multi-agent run emits one `runner-finished` PER runner
  // (each sub-agent AND the root). Only the ROOT finish is a session-end,
  // so we track each session's root runner (the first parentless
  // `runner-started`) and notify ONLY when the finishing runner IS that
  // root. Fail-closed: an unknown root suppresses the notification.
  const notifyLog = log.child("notify")
  const notifier = createNotificationService({
    showNotification: (n) => {
      void import("electrobun/bun").then(({ Utils }) =>
        Utils.showNotification(n),
      )
    },
    isWindowFocused,
  })
  // Resolve a finished session's harness + cwd for the notification body.
  const resolveSessionInfo: SessionInfoResolver = (sessionId) => {
    const queried = shared.sessions.query()
    if (!queried.ok) return undefined
    const found = queried.value.find((s) => String(s.id) === sessionId)
    if (found === undefined) return undefined
    return {
      harnessId: String(found.harnessId),
      ...(found.cwd !== undefined ? { cwd: found.cwd } : {}),
    }
  }
  let roots: RootRunnerMap = new Map()
  const notifyOnRunFinished = (message: RunnerOutbound): void => {
    if (message.type === "runner-event") {
      const sessionId = message.id
      const inner = message.event.event
      roots = trackRootRunner(roots, sessionId, inner)
      if (!isRootRunnerFinished(roots, sessionId, inner)) return
    }
    const finished = mapRunFinished(message, resolveSessionInfo)
    if (finished === null) return
    notifyLog.info("run-finished native notification dispatched", {
      sessionId: finished.sessionId,
      harnessId: finished.harnessId,
      status: finished.status,
    })
    notifier.onRunFinished(finished)
  }

  // ------------------------------------------------------------------
  // AI session naming — bounded one-shot generateText seam (proxy package)
  // ------------------------------------------------------------------
  // Resolves the route+provider+secrets from the live config.
  // SECURITY: logs { kind } only at the boundary; never the prompt or secrets (see proxy CLAUDE.md).
  const proxyNameGen = createNameGenerator({
    config: shared.config,
    factory: shared.factory,
    clock: shared.clock,
    logger: log.child("sessionName"),
  })
  const nameGenerator: NameGeneratorPort = {
    generate: (modelId, firstPrompt, signal) =>
      proxyNameGen.generate(modelId, firstPrompt, signal),
  }

  // ------------------------------------------------------------------
  // Runner — built from the SHARED extension points (no re-derivation)
  // ------------------------------------------------------------------
  const baseRunner = deps.createRunManager({
    driver: shared.routingDriver,
    sessions: shared.sessionSink,
    events: shared.runStore,
    clock: shared.clock,
    logger: log.child("runner"),
    // Before the webview socket connects, the manager's sink is this notifier tap.
    send: notifyOnRunFinished,
    resolveModelEnv: shared.resolveModelEnv,
    resolveResumeInput: shared.resolveResumeInput,
    sessionNameModelId: async () => {
      const loaded = await shared.config.load()
      if (!loaded.ok) return null
      const id = loaded.value.settings.sessionNameModelId
      return id === null ? null : (id as ModelId)
    },
    generateName: nameGenerator,
  })
  // The runner socket calls `bindSend` on connect, REPLACING the manager's
  // sink with one that pushes to the live websocket. `withNotifierTap`
  // composes the notifier tap INTO that socket sink so native notifications
  // fire regardless of which socket is bound.
  const runner: RunManager = withNotifierTap(baseRunner, notifyOnRunFinished)

  // ------------------------------------------------------------------
  // Renderer watchdog — sustained disconnect ⇒ WKWebView content died
  // ------------------------------------------------------------------
  const rendererWatchdog = deps.createRendererWatchdog({
    timers: realWatchdogTimers,
    logger: log.child("renderer-watchdog"),
    onGiveUp: () => {
      void import("electrobun/bun").then(({ Utils }) =>
        Utils.showNotification({
          title: "Spectrum",
          body: "The window stopped responding and couldn't recover. Please restart Spectrum.",
        }),
      )
    },
  })

  // ------------------------------------------------------------------
  // Runner socket — loopback WebSocket for canonical run-event stream
  // ------------------------------------------------------------------
  const runnerSocket: RunnerSocket = deps.startRunnerSocket(runner, {
    onConnect: () => rendererWatchdog.onConnect(),
    onDisconnect: () => rendererWatchdog.onDisconnect(),
  })

  // ------------------------------------------------------------------
  // Terminal (in-app terminal panel) — dedicated PTY registry + socket
  // ------------------------------------------------------------------
  // The TerminalManager owns a single PTY per (sessionId, tabId) pair; the socket fans PTY bytes
  // out to the webview over a separate loopback WebSocket (independent of the runner socket).
  //
  // The PTY is allocated with libc `openpty(3)` via `bun:ffi` (Bun-native; node-pty
  // does not deliver bytes under the Bun runtime). When that's unavailable (Windows,
  // or `bun:ffi`/libutil missing), fall back to a no-op manager that emits a
  // "Terminal unavailable" `term-error` so the pane shows a toast instead of a silent
  // black box.
  const nativePtyAvailable = checkNativePtyAvailable()
  if (nativePtyAvailable) {
    log
      .child("terminal")
      .info("native pty available, using bun:ffi terminal manager")
  } else {
    log
      .child("terminal")
      .warn(
        "native pty unavailable (bun:ffi openpty could not load) — using no-op terminal manager; the in-app terminal will report 'Terminal unavailable'",
      )
  }
  const terminalManager = nativePtyAvailable
    ? createTerminalManager({
        spawner: createBunFfiPtySpawner(),
        log: log.child("terminal"),
      })
    : createNoopTerminalManager()
  const terminalSocket: TerminalSocket = deps.startTerminalSocket(
    terminalManager,
    {
      onConnect: () => log.child("terminal").info("terminal socket connected"),
      onDisconnect: () =>
        log.child("terminal").info("terminal socket disconnected"),
    },
  )

  // ------------------------------------------------------------------
  // Factory reset — uses shared dataDir/legacyDirs, GUI relaunch seam
  // ------------------------------------------------------------------
  const resetApp = createResetApp({
    config: shared.config,
    secrets: shared.secrets,
    closeDb: shared.closeDb,
    removeDir: deps.removeDir,
    relaunch: deps.relaunch,
    dataDir: shared.paths.dataDir,
    legacyDirs: shared.legacyDirs,
    logger: log.child("reset"),
  })

  // ------------------------------------------------------------------
  // Updater — lazy Electrobun engine
  // ------------------------------------------------------------------
  const updater = createElectrobunUpdater()

  // ------------------------------------------------------------------
  // Update push socket + poller — pushes fresh UpdateState while the app is open
  // ------------------------------------------------------------------
  const updateSocket: UpdateSocket = deps.startUpdateSocket()
  const pushUpdateState = async (): Promise<void> => {
    try {
      const loaded = await shared.config.load()
      const buildChannel = await updater.getBuildChannel()
      const channel: "stable" | "canary" =
        buildChannel ??
        (isOk(loaded) ? loaded.value.settings.updateChannel : "stable")
      await updater.check(channel) // non-fatal; raw snapshot records errors
      const state = await buildUpdateState({ updater, config: shared.config })
      updateSocket.push(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log.child("update").error(`update.push.error: ${detail}`)
    }
  }
  const updatePoller = createUpdatePoller({
    check: pushUpdateState,
    getPhase: () => updater.getRaw().phase,
    intervalMs: UPDATE_POLL_INTERVAL_MS,
    timers: deps.pollerTimers,
    logger: log.child("update.poll"),
  })
  updatePoller.start()

  // ------------------------------------------------------------------
  // Native folder picker — lazy so bun test never loads native FFI
  // ------------------------------------------------------------------
  const pickFolder: GuiContext["pickFolder"] = async (opts) => {
    const { Utils } = await import("electrobun/bun")
    const paths = await Utils.openFileDialog({
      canChooseDirectory: true,
      canChooseFiles: false,
      allowsMultipleSelection: false,
      ...(opts.startingFolder === undefined
        ? {}
        : { startingFolder: opts.startingFolder }),
    })
    // Empty/cancelled selection comes back as [""] from the comma-split; drop it.
    return paths.filter((p) => p.trim() !== "")
  }

  // ------------------------------------------------------------------
  // OS-default URL opener — lazy import
  // ------------------------------------------------------------------
  const openExternalUrl: GuiContext["openExternalUrl"] = async (url) => {
    const { Utils } = await import("electrobun/bun")
    return Utils.openExternal(url)
  }

  // ------------------------------------------------------------------
  // Session row / project path resolvers — feed the terminal cwd handler.
  //
  // `SessionSink.get` returns the public `Session` (which drops `projectId`), so the GUI composes
  // its own row lookup through the shared `sessions` store. `SessionRow` is the drizzle-typed row
  // and retains `projectId`. Both resolve closures return `undefined` on db-error so the IPC
  // handler's terminal-cwd logic treats a missing row/folder uniformly with "unknown id".
  // ------------------------------------------------------------------
  const resolveSessionRow = async (
    sessionId: SessionId,
  ): Promise<
    | {
        readonly cwd: string | undefined
        readonly projectId: string | undefined
      }
    | undefined
  > => {
    const row = shared.sessions.findById(sessionId)
    if (!row.ok || row.value === undefined) return undefined
    return {
      cwd: row.value.cwd ?? undefined,
      projectId: row.value.projectId,
    }
  }
  // The IPC contract passes the project id as a plain string (it comes from the DB row); the
  // branded `ProjectId` is enforced at the store boundary.
  const resolveProjectPath = async (
    projectId: string,
  ): Promise<string | undefined> => {
    const p = shared.projects.findById(projectId as ProjectId)
    if (!p.ok || p.value === undefined) return undefined
    return p.value.path
  }

  return {
    ...shared,
    runner,
    runnerSocketUrl: runnerSocket.url,
    rendererWatchdog,
    resetApp,
    pickFolder,
    openExternalUrl,
    updater,
    terminalManager,
    terminalSocketUrl: terminalSocket.url,
    updateSocketUrl: updateSocket.url,
    pushUpdateState,
    resolveSessionRow,
    resolveProjectPath,
    homeDir: homedir(),
    ensureGuiPathResolved: deps.ensureGuiPathResolved,
  }
}

// ---------------------------------------------------------------------------
// Type re-exports for gui/* consumers that import `RunManager` etc.
// ---------------------------------------------------------------------------
export type { RunManager, RunManagerDeps, AgentDriver }
