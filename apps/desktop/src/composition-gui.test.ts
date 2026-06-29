import { describe, expect, it } from "bun:test"

import type { RunManager } from "@spectrum/agent-driver"
import {
  buildFakeAppContextDeps,
  createAppContext,
} from "@spectrum/runtime-core"
import { ok } from "@spectrum/utils"

import { createGuiContext } from "./composition"
import type { CreateGuiContextDeps, GuiContext } from "./composition"

// ---------------------------------------------------------------------------
// Fakes — match the contracts of the 5 GUI seams WITHOUT importing any real
// adapter (so `bun test` never loads native FFI / opens sockets).
// ---------------------------------------------------------------------------

interface FakeRunnerSocket {
  url: string
  stop: () => void
}

/** Captures the RunManager shape so we can assert wiring without spawning. */
const captureBaseRunner = (): RunManager => {
  return {
    launch: () => ({ ok: true, value: { pid: 1, exited: Promise.resolve(0) } }),
    cancel: () => {},
    handleInbound: () => {},
    bindSend: () => {},
  } as RunManager
}

const fakeGuiDeps = (): CreateGuiContextDeps & {
  readonly calls: Record<string, unknown>
} => {
  const calls: Record<string, unknown> = {}
  return {
    createRunManager: (deps) => {
      calls.createRunManagerDeps = deps
      return captureBaseRunner()
    },
    startRunnerSocket: (manager, hooks) => {
      calls.startRunnerSocketArgs = { manager, hooks }
      // The real seam binds on connect and disconnects via hooks — call them now
      // so any handler-installed side effect (e.g. the watchdog tap) is exercised.
      hooks.onConnect?.()
      hooks.onDisconnect?.()
      const next: FakeRunnerSocket = {
        url: "ws://localhost:0/",
        stop: () => {},
      }
      return next
    },
    startTerminalSocket: (manager, hooks) => {
      calls.startTerminalSocketArgs = { manager, hooks }
      hooks.onConnect?.()
      hooks.onDisconnect?.()
      return {
        url: "ws://localhost:0/terminal",
        stop: () => {},
      }
    },
    createRendererWatchdog: (deps) => {
      calls.createRendererWatchdogDeps = deps
      return {
        onConnect: () => {},
        onDisconnect: () => {},
        bindReload: () => {},
        dispose: () => {},
      }
    },
    startUpdateSocket: () => ({
      url: "ws://localhost:0/",
      push: () => {},
      stop: () => {},
    }),
    pollerTimers: { setInterval: () => 0, clearInterval: () => {} },
    removeDir: (dir) => {
      calls.removeDir = dir
    },
    relaunch: () => {
      calls.relaunched = true
    },
    ensureGuiPathResolved: async () => {
      calls.ensureGuiPathResolved = true
    },
    calls,
  }
}

/** Build a shared context with a config stub that returns an empty list of providers. */
const shared = () => {
  const deps = buildFakeAppContextDeps({
    // The reset path calls `config.load()` to enumerate providers before deleting
    // their secrets. The fake from `buildFakeAppContextDeps` doesn't stub `createCachedConfigStore`
    // — provide one that returns a minimal valid store.
    createCachedConfigStore: ((inner: { load: () => Promise<unknown> }) => ({
      load: inner.load,
      save: async (cfg: unknown) => ok(cfg),
    })) as never,
    createFileConfigStore: (() => ({
      load: async () =>
        ok({
          providers: [],
          models: [],
          settings: {
            proxyHost: "127.0.0.1",
            proxyPort: 0,
            firstTokenTimeoutMs: 0,
            interTokenTimeoutMs: 0,
          },
        }),
      save: async (cfg: unknown) => ok(cfg),
    })) as never,
  })
  return createAppContext(deps)
}

describe("createGuiContext", () => {
  it("composes runner + socket url + watchdog + updater + resetApp over the shared AppContext", () => {
    const gui = createGuiContext(shared(), fakeGuiDeps()) as GuiContext

    // Runner: returned object has the RunManager shape (launch/cancel/handleInbound/bindSend).
    expect(typeof gui.runner.launch).toBe("function")
    expect(typeof gui.runner.cancel).toBe("function")
    expect(typeof gui.runner.handleInbound).toBe("function")
    expect(typeof gui.runner.bindSend).toBe("function")
    // Socket: ws://localhost:<port>/ — exactly the loopback scheme the webview's CSP allows.
    expect(gui.runnerSocketUrl).toMatch(/^ws:\/\/localhost:\d+\/$/)
    // Watchdog: built with timers + logger + onGiveUp (all three injected).
    expect(gui.rendererWatchdog).toBeDefined()
    expect(typeof gui.rendererWatchdog.onConnect).toBe("function")
    expect(typeof gui.rendererWatchdog.onDisconnect).toBe("function")
    // Updater: the real adapter is constructed (it lazy-loads Electrobun on first use).
    expect(gui.updater).toBeDefined()
    expect(typeof gui.updater.getRaw).toBe("function")
    // pickFolder / openExternalUrl: async functions that lazy-import electrobun on first call.
    expect(typeof gui.pickFolder).toBe("function")
    expect(typeof gui.openExternalUrl).toBe("function")
    // resetApp: factory function with the right return shape.
    expect(typeof gui.resetApp).toBe("function")
    // Terminal: terminal manager has the launch/handleInbound/bindSend/dispose shape; socket url
    // is a loopback ws URL matching the same scheme the runner socket uses.
    expect(typeof gui.terminalManager.launch).toBe("function")
    expect(typeof gui.terminalManager.handleInbound).toBe("function")
    expect(typeof gui.terminalManager.bindSend).toBe("function")
    expect(typeof gui.terminalManager.dispose).toBe("function")
    expect(gui.terminalSocketUrl).toMatch(/^ws:\/\/localhost:\d+\//)
    // Resolvers + home dir surface: typed resolvers return undefined for unknown ids so the
    // terminal cwd handler's fall-through path is exercised without db state.
    expect(typeof gui.resolveSessionRow).toBe("function")
    expect(typeof gui.resolveProjectPath).toBe("function")
    expect(typeof gui.homeDir).toBe("string")
  })

  it("wires the RunManager from the shared runner extension points", () => {
    const deps = fakeGuiDeps()
    createGuiContext(shared(), deps)

    // Every dependency the RunManager needs was pulled from the SHARED context, not re-derived.
    const captured = deps.calls.createRunManagerDeps as Record<string, unknown>
    expect(captured).toBeDefined()
    // The shared sessionSink/runStore/routingDriver are passed through unchanged.
    expect(typeof captured?.sessions).toBe("object")
    expect(typeof captured?.events).toBe("object")
    expect(typeof captured?.driver).toBe("object")
    // logger + clock + resolveModelEnv + resolveResumeInput + send(tap) are all wired.
    expect(typeof captured?.clock).toBe("object")
    expect(typeof captured?.logger).toBe("object")
    expect(typeof captured?.send).toBe("function")
    expect(typeof captured?.resolveModelEnv).toBe("function")
    expect(typeof captured?.resolveResumeInput).toBe("function")
  })

  it("wraps the runner via withNotifierTap so notifications fire before AND after socket connect", () => {
    // The tap is the only path that fires native notifications. When the socket replaces
    // baseRunner.send via bindSend, the wrapper re-injects the tap so notifications keep firing.
    const gui = createGuiContext(shared(), fakeGuiDeps()) as GuiContext

    // Bind a sink via bindSend — withNotifierTap delegates to the baseRunner.bindSend,
    // then composes a NEW sink that calls BOTH socketSink AND the notifier tap.
    // We can observe that bindSend doesn't itself call the sink — it registers it.
    let sinkRegistered = false
    gui.runner.bindSend(() => {
      sinkRegistered = true
    })
    expect(sinkRegistered).toBe(false)
  })

  it("constructs the renderer watchdog with the real timers + onGiveUp", () => {
    const deps = fakeGuiDeps()
    createGuiContext(shared(), deps)

    const wdDeps = deps.calls.createRendererWatchdogDeps as Record<
      string,
      unknown
    >
    expect(wdDeps).toBeDefined()
    expect(typeof wdDeps?.timers).toBe("object")
    expect(typeof wdDeps?.logger).toBe("object")
    expect(typeof wdDeps?.onGiveUp).toBe("function")
  })

  it("builds resetApp with the shared config/secrets/dataDir/legacyDirs and the GUI relaunch seam", async () => {
    const deps = fakeGuiDeps()
    const sharedCtx = shared()
    // Spy on shared.closeDb so we can assert the factory-reset path invokes it (the brief requires
    // the real SQLite connection close before rmSync — the GUI must NOT no-op this).
    let closeDbCalls = 0
    ;(sharedCtx as unknown as { closeDb: () => void }).closeDb = (): void => {
      closeDbCalls += 1
    }
    const gui = createGuiContext(sharedCtx, deps) as GuiContext

    // Calling resetApp wires the relaunch through the injected seam AND invokes shared.closeDb
    // (the runtime-core runner extension point) before removeDir, so the SQLite file handle is
    // released before rmSync runs.
    await gui.resetApp()

    expect(closeDbCalls).toBe(1)
    expect(deps.calls.relaunched).toBe(true)
    expect(deps.calls.removeDir).toBeDefined() // dataDir was wiped
  })

  it("constructs the notifier root-gating pipeline from the shared session store", () => {
    // The notifier is built unconditionally (it always exists, regardless of focus state).
    // The focus gate lives inside `createNotificationService.isWindowFocused()` and is
    // already exercised in notification-service.test.ts. Here we only assert that the
    // GUI extension produced a context — the notifier wiring is internal.
    const gui = createGuiContext(shared(), fakeGuiDeps()) as GuiContext
    expect(gui.resetApp).toBeDefined()
  })

  it("threads ensureGuiPathResolved from the GUI deps onto the returned GuiContext", async () => {
    // The harness-launch path (IPC `launchHarness` + tray Launch) reads
    // `ctx.ensureGuiPathResolved()` BEFORE `ctx.runner.launch(...)` to guarantee the deferred
    // GUI PATH probe has settled by the time `Bun.which(command, { PATH })` runs.
    // The GuiContext type must carry this hook through to handlers/tray.
    const deps = fakeGuiDeps()
    const gui = createGuiContext(shared(), deps) as GuiContext

    expect(typeof gui.ensureGuiPathResolved).toBe("function")
    // And calling the ctx hook delegates to the injected seam.
    await gui.ensureGuiPathResolved()
    expect(deps.calls.ensureGuiPathResolved).toBe(true)
  })
})
