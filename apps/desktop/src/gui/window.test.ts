import { describe, expect, it, mock } from "bun:test"
import type { AppContext } from "../composition"
import { openWindow } from "./window"
import type { OpenWindowDeps, WindowOptions } from "./window"

const fakeCtx = {} as AppContext

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

  it("locks the window to the app origin and disables remote content when called", () => {
    const { deps, created } = makeDeps()
    openWindow(fakeCtx, deps)
    // security.md webview hardening: navigation locked to the app origin, no remote scripts.
    expect(created[0]?.lockNavigationToOrigin).toBe(true)
  })

  it("wires the IPC server over the Electrobun transport when called", () => {
    const wireServer = mock(() => {})
    const { deps } = makeDeps({ wireServer })
    openWindow(fakeCtx, deps)
    expect(wireServer).toHaveBeenCalledTimes(1)
  })
})
