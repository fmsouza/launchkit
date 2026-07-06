import { beforeEach, describe, expect, it } from "bun:test"
import { SessionIdSchema } from "@spectrum/types"
import { useTerminalStore } from "./terminalStore"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)

// Bun's test env has no `localStorage`; stub an in-memory implementation so the
// store's persist/hydrate logic runs against the same shape browsers provide.
// `globalThis.localStorage` is a read-only getter in Bun's test env, so install
// the stub via `Object.defineProperty` instead of plain assignment.
const store: Record<string, string> = {}
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    key: () => null,
    length: 0,
  } as Storage,
  writable: true,
  configurable: true,
})

beforeEach(() => {
  useTerminalStore.setState({ sessions: {} })
  // clear localStorage mock
  ;(globalThis as { localStorage?: Storage }).localStorage?.clear?.()
})

// Tiny non-null helper to satisfy `lint/style/noNonNullAssertion`. Reads
// `useTerminalStore.getState().sessions[id]` and throws if the session is
// missing — tests assert the precondition holds, not the runtime shape.
const session = (id: typeof sessionId) => {
  const s = useTerminalStore.getState().sessions[id]
  if (!s) throw new Error(`no session ${id}`)
  return s
}

// Same non-null helper for `s.tabs[n]`.
const tab = (s: { tabs: ReadonlyArray<{ id: string }> }, n: number) => {
  const t = s.tabs[n]
  if (!t) throw new Error(`no tab ${n}`)
  return t
}

describe("terminalStore", () => {
  it("opens the pane for a session with a first tab", () => {
    useTerminalStore.getState().openPane(sessionId)
    const s = session(sessionId)
    expect(s.paneOpen).toBe(true)
    expect(s.tabs).toHaveLength(1)
    expect(s.activeTabId).toBe(tab(s, 0).id)
  })

  it("closePane sets paneOpen=false but keeps tabs", () => {
    useTerminalStore.getState().openPane(sessionId)
    useTerminalStore.getState().closePane(sessionId)
    const s = session(sessionId)
    expect(s.paneOpen).toBe(false)
    expect(s.tabs.length).toBeGreaterThan(0)
  })

  it("newTab adds a tab and activates it", () => {
    useTerminalStore.getState().openPane(sessionId)
    useTerminalStore.getState().newTab(sessionId)
    const s = session(sessionId)
    expect(s.tabs).toHaveLength(2)
    expect(s.activeTabId).toBe(tab(s, 1).id)
  })

  it("closeTab removes a tab and deactivates the pane when none remain", () => {
    useTerminalStore.getState().openPane(sessionId)
    const s = session(sessionId)
    useTerminalStore.getState().closeTab(sessionId, tab(s, 0).id)
    const after = session(sessionId)
    expect(after.tabs).toHaveLength(0)
    expect(after.paneOpen).toBe(false)
  })

  it("setHeight updates paneHeightPx", () => {
    useTerminalStore.getState().openPane(sessionId)
    useTerminalStore.getState().setHeight(sessionId, 250)
    expect(session(sessionId).paneHeightPx).toBe(250)
  })

  it("persist paneOpen + height across store re-init, but not tabs", () => {
    useTerminalStore.getState().openPane(sessionId)
    useTerminalStore.getState().setHeight(sessionId, 300)
    // simulate restart: re-hydrate from localStorage
    useTerminalStore.setState({ sessions: {} })
    useTerminalStore.getState().hydrate(sessionId)
    const s = session(sessionId)
    expect(s.paneOpen).toBe(true)
    expect(s.paneHeightPx).toBe(300)
    expect(s.tabs).toHaveLength(0) // tabs do not persist
  })
})
