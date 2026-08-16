import { describe, expect, it, mock } from "bun:test"
import { resolveHarnessLaunch } from "@spectrum/harnesses"
import { createFakeCommandResolver } from "@spectrum/proc"
import {
  type HarnessDefinition,
  HarnessIdSchema,
  type Session,
} from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import type { GuiContext } from "../composition"
import { mountTray } from "./tray"
import type { MountTrayDeps, TrayHandle } from "./tray"
import type { TrayMenu } from "./tray-menu"

const harness: HarnessDefinition = {
  id: HarnessIdSchema.parse("claude"),
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  builtIn: true,
}

const sampleSession: Session = {
  id: HarnessIdSchema.parse("s_1") as unknown as Session["id"],
  harnessId: harness.id,
  startedAt: "2026-05-23T10:00:00.000Z",
}

/**
 * `mountTray`'s click handler fires the async launch as a detached microtask (`void launchById(...)`)
 * because Electrobun click callbacks are synchronous `void`. The launch awaits a few promises
 * (`registry.list`, `config.load`), so a test must drain the microtask queue before asserting.
 */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A fake AppContext exposing only what mountTray touches, capturing launch + session calls. */
const makeCtx = (
  over: {
    harnesses?: readonly HarnessDefinition[]
    proxyRunning?: boolean
    runnerOk?: boolean
    nativeHarnessId?: string
    /** Async hook the tray awaits before `ctx.runner.launch(...)`. When provided, tests use
     *  `order.push(...)` to assert this resolves before the launch fires. Defaults to a no-op. */
    ensureGuiPathResolved?: () => Promise<void>
  } = {},
): {
  ctx: GuiContext
  runnerInputs: unknown[]
  sessionInputs: unknown[]
} => {
  const runnerInputs: unknown[] = []
  const sessionInputs: unknown[] = []
  const resolveLaunch = resolveHarnessLaunch({
    resolver: createFakeCommandResolver({ claude: "/usr/local/bin/claude" }),
  })
  const ctx = {
    registry: { list: async () => ok(over.harnesses ?? [harness]) },
    resolveLaunch,
    driverRegistry: {
      get: () => undefined,
      isNative: (harnessId: unknown) =>
        String(harnessId) === (over.nativeHarnessId ?? "claude"),
    },
    runtime: {
      readProxyKey: async () => null,
      writeProxyKey: async () => ok(undefined),
      clear: async () => undefined,
    },
    runner: {
      launch: (input: unknown) => {
        runnerInputs.push(input)
        return over.runnerOk === false
          ? err({ kind: "start-failed", detail: "no driver" })
          : ok({ sessionId: sampleSession.id })
      },
      handleInbound: () => undefined,
      bindSend: () => undefined,
    },
    sessions: {
      init: () => ok(undefined),
      create: (input: unknown) => {
        sessionInputs.push(input)
        return ok(sampleSession)
      },
      close: () => ok(sampleSession),
      query: () => ok([sampleSession]),
    },
    proxy: {
      isRunning: async () => over.proxyRunning ?? true,
      start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
    },
    proxyBaseUrl: "http://127.0.0.1:4000",
    genProxyKey: () => "k-test",
    config: {
      load: async () =>
        ok({
          version: 2,
          providers: [],
          models: [],
          settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
        }),
      save: async () => ok(undefined),
    },
    // Default to a no-op so existing tests keep their original behavior; the
    // PATH-resolved order test overrides this with an order-recording stub.
    ensureGuiPathResolved: over.ensureGuiPathResolved ?? (async () => {}),
  } as unknown as GuiContext
  return { ctx, runnerInputs, sessionInputs }
}

/**
 * A fake tray seam that records every rendered menu and captures the seam's `onClick` dispatcher,
 * so a test can fire a click by its clickId. No real Electrobun is touched.
 */
const captureTray = (): {
  deps: MountTrayDeps
  rendered: TrayMenu[]
  click: (clickId: string) => void
} => {
  const rendered: TrayMenu[] = []
  let onClick: ((clickId: string) => void) | undefined
  const deps: MountTrayDeps = {
    createTray: (
      menu: TrayMenu,
      handler: (clickId: string) => void,
    ): TrayHandle => {
      rendered.push(menu)
      onClick = handler
      return { setMenu: (m: TrayMenu) => rendered.push(m), destroy: () => {} }
    },
  }
  return {
    deps,
    rendered,
    click: (clickId: string): void => {
      if (onClick === undefined)
        throw new Error("createTray was not called before click()")
      onClick(clickId)
    },
  }
}

describe("mountTray", () => {
  it("renders the menu built from the registry and live proxy status when mounted", async () => {
    const { ctx } = makeCtx({ harnesses: [harness], proxyRunning: true })
    const { deps, rendered } = captureTray()

    await mountTray(ctx, { openWindow: () => {}, quit: () => {} }, deps)

    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.items[0]).toMatchObject({
      kind: "status",
      dot: { state: "on", color: "green" },
    })
    const submenu = rendered[0]?.items.find((i) => i.kind === "submenu")
    expect(submenu).toMatchObject({
      kind: "submenu",
      items: [{ kind: "launch", harnessId: "claude" }],
    })
  })

  it("opens a DEFAULT (bypass) native run session and focuses the window when a Launch item is clicked", async () => {
    const { ctx, runnerInputs, sessionInputs } = makeCtx({
      harnesses: [harness],
    })
    const openWindow = mock(() => {})
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow, quit: () => {} }, deps)
    click("launch:claude")
    await flushMicrotasks() // let the detached launchById promises settle

    // Same path as the IPC handler: resolve then ctx.runner.launch — the manager owns the session.
    // A tray quick-launch is a DEFAULT launch = bypass the proxy (route kind "direct").
    expect(runnerInputs).toHaveLength(1)
    const input = runnerInputs[0] as Record<string, unknown> & {
      env: Record<string, string>
    }
    expect(input.harnessId).toBe(harness.id)
    expect(input.command).toBe("/usr/local/bin/claude")
    // Bypass: no modelId/alias on the session ...
    expect("modelId" in input).toBe(false)
    expect("alias" in input).toBe(false)
    // ... and no proxy env was rendered.
    expect("ANTHROPIC_BASE_URL" in input.env).toBe(false)
    expect("ANTHROPIC_API_KEY" in input.env).toBe(false)
    // The handler must NOT create a session directly (the manager does it).
    expect(sessionInputs).toEqual([])
    // The window is brought forward so the user sees the new session.
    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it("invokes openWindow when the Open Spectrum item is clicked", async () => {
    const { ctx } = makeCtx()
    const openWindow = mock(() => {})
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow, quit: () => {} }, deps)
    click("open")

    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it("invokes quit when the Quit item is clicked", async () => {
    const { ctx } = makeCtx()
    const quit = mock(() => {})
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow: () => {}, quit }, deps)
    click("quit")

    expect(quit).toHaveBeenCalledTimes(1)
  })

  it("does not record a session when the runner fails to launch", async () => {
    const { ctx, sessionInputs } = makeCtx({
      harnesses: [harness],
      runnerOk: false,
    })
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow: () => {}, quit: () => {} }, deps)
    click("launch:claude")
    await flushMicrotasks() // let the detached launchById promises settle

    expect(sessionInputs).toEqual([]) // driver failed → no session recorded
  })

  it("does not launch a harness with no native driver", async () => {
    const { ctx, runnerInputs } = makeCtx({
      harnesses: [harness],
      nativeHarnessId: "__none__",
    })
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow: () => {}, quit: () => {} }, deps)
    click("launch:claude")
    await flushMicrotasks()

    expect(runnerInputs).toEqual([])
  })

  it("awaits ctx.ensureGuiPathResolved before invoking ctx.runner.launch", async () => {
    // The tray quick-launch path must await the deferred PATH probe before the resolver reads
    // process.env.PATH — otherwise the probe can race the launch and a fresh GUI app misses
    // the user's login-shell PATH.
    const order: string[] = []
    const { ctx } = makeCtx({
      harnesses: [harness],
      ensureGuiPathResolved: async () => {
        order.push("path-resolved")
      },
    })
    // Wrap runner.launch so it appends to the same ordered array.
    ;(ctx.runner as unknown as { launch: (input: unknown) => unknown }).launch =
      (input: unknown) => {
        order.push("launched")
        void input
        return ok({ sessionId: sampleSession.id })
      }
    const { deps, click } = captureTray()

    await mountTray(ctx, { openWindow: () => {}, quit: () => {} }, deps)
    click("launch:claude")
    await flushMicrotasks()

    expect(order).toEqual(["path-resolved", "launched"])
  })
})
