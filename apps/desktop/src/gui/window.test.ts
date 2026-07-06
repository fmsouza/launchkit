import { describe, expect, it, mock } from "bun:test"
import type { GuiContext } from "../composition"
import { bindExternalNavigation, bindWebviewReload, openWindow } from "./window"
import type { OpenWindowDeps, WindowOptions } from "./window"
import type { WindowBounds } from "./window-bounds"
import type { WindowBoundsIO } from "./window-bounds-io"

const fakeCtx = {} as GuiContext

const fakeIO = (): WindowBoundsIO => ({
  loadInitialFrame: async (): Promise<WindowBounds> => ({
    width: 1024,
    height: 720,
    x: 100,
    y: 100,
  }),
  onBoundsChange: () => {},
})

const makeDeps = (
  over: Partial<OpenWindowDeps> = {},
): {
  deps: OpenWindowDeps
  created: WindowOptions[]
  serverWired: number
} => {
  const created: WindowOptions[] = []
  let serverWired = 0
  const deps: OpenWindowDeps = {
    createWindow: mock((opts: WindowOptions) => {
      created.push(opts)
      return { id: 1 }
    }),
    makeTransport: mock(() => ({ onRequest: () => {} })),
    wireServer: mock(() => {
      serverWired += 1
    }),
    createBoundsIO: mock(() => fakeIO()),
    viewUrl: "views://main/index.html",
    ...over,
  }
  return { deps, created, serverWired }
}

describe("openWindow", () => {
  it("creates a window pointed at the built views/main entry when called", () => {
    const { deps, created } = makeDeps()
    openWindow(fakeCtx, deps)
    expect(created).toHaveLength(1)
    expect(created[0]?.url).toBe("views://main/index.html")
  })

  it("wires the IPC server over the Electrobun transport when called", () => {
    const wireServer = mock(() => {})
    const { deps } = makeDeps({ wireServer })
    openWindow(fakeCtx, deps)
    expect(wireServer).toHaveBeenCalledTimes(1)
  })

  it("builds the bounds IO from the context and threads it into the window", () => {
    const io = fakeIO()
    const createBoundsIO = mock(() => io)
    const { deps, created } = makeDeps({ createBoundsIO })
    openWindow(fakeCtx, deps)
    expect(createBoundsIO).toHaveBeenCalledTimes(1)
    expect(created[0]?.loadInitialFrame).toBe(io.loadInitialFrame)
    expect(created[0]?.onBoundsChange).toBe(io.onBoundsChange)
  })
})

describe("bindExternalNavigation", () => {
  // The real Electrobun will-navigate event is an ElectrobunEvent whose URL is
  // at `event.data.detail` (see electrobun/dist/api/bun/events/webviewEvents.ts
  // — `willNavigate: (data: { detail: string }) => ...`). The handler must read
  // that field. These tests use the real shape, not a fabricated `{ url }`.
  //
  // This verifies the best-effort side-effect contract only: a will-navigate to
  // an EXTERNAL url calls openExternal. It does NOT (and cannot) verify
  // navigation prevention — will-navigate is observational in Electrobun 1.18.1
  // (see bindExternalNavigation's doc comment). A real origin-lock would use
  // BrowserView.setNavigationRules and is tracked as a follow-up.
  type NavEvent = { readonly data: { readonly detail: string } }
  const wireNav = (
    openExternal: (url: string) => boolean,
  ): ((event: NavEvent) => void) => {
    let navHandler: ((event: NavEvent) => void) | undefined
    const win = {
      webview: {
        on: (_name: "will-navigate", handler: (event: NavEvent) => void) => {
          navHandler = handler
        },
      },
    }
    bindExternalNavigation(win, openExternal)
    if (navHandler === undefined) throw new Error("handler not registered")
    return navHandler
  }

  it("opens an external http(s) will-navigate url in the browser (best-effort side-effect)", () => {
    let opened: string | undefined
    const navHandler = wireNav((url) => {
      opened = url
      return true
    })
    navHandler({ data: { detail: "https://example.com" } })
    expect(opened).toBe("https://example.com")
  })

  it("ignores navigation to the app's own views:// origin (does not open it externally)", () => {
    // CEF on Linux fires will-navigate for the SPA's own startup load. Routing
    // that to the OS browser is wrong (and historically crashed the process).
    let called = false
    const navHandler = wireNav(() => {
      called = true
      return true
    })
    navHandler({ data: { detail: "views://main/index.html" } })
    expect(called).toBe(false)
  })

  it("never calls openExternal with a non-string detail (crash regression: toCString(undefined))", () => {
    // The startup crash was Utils.openExternal(undefined) -> toCString(undefined)
    // -> `undefined.endsWith` TypeError, which killed the bun worker before the
    // proxy could start (CI smoke /health failure). Guard against it.
    let called = false
    const navHandler = wireNav(() => {
      called = true
      return true
    })
    navHandler({ data: { detail: undefined as unknown as string } })
    expect(called).toBe(false)
  })
})

describe("bindWebviewReload", () => {
  it("hands back a reload fn that loads the view url into the webview", () => {
    const loaded: string[] = []
    const win: { webview: { loadURL(url: string): void } } = {
      webview: { loadURL: (url: string) => loaded.push(url) },
    }
    const captured: { fn: (() => void) | null } = { fn: null }
    bindWebviewReload(win, "views://main/index.html", (reload) => {
      captured.fn = reload
    })
    expect(loaded).toHaveLength(0) // not loaded until invoked
    captured.fn?.()
    expect(loaded).toEqual(["views://main/index.html"])
  })
})
