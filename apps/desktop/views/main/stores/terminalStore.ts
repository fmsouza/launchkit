import type { SessionId } from "@spectrum/types"
import { create } from "zustand"

export interface TerminalTab {
  readonly id: string
  title: string
  exitCode: number | null
  closed: boolean
}

export interface SessionTerminalState {
  tabs: TerminalTab[]
  activeTabId: string | null
  paneOpen: boolean
  paneHeightPx: number
}

interface TerminalStoreState {
  sessions: Record<string, SessionTerminalState>
  openPane: (sessionId: SessionId) => void
  closePane: (sessionId: SessionId) => void
  newTab: (sessionId: SessionId) => void
  closeTab: (sessionId: SessionId, tabId: string) => void
  selectTab: (sessionId: SessionId, tabId: string) => void
  setHeight: (sessionId: SessionId, px: number) => void
  setTabExit: (sessionId: SessionId, tabId: string, exitCode: number) => void
  clearSession: (sessionId: SessionId) => void
  hydrate: (sessionId: SessionId) => void
}

const DEFAULT_HEIGHT = 220
const newTabId = (): string => crypto.randomUUID()

const storageKey = (sessionId: SessionId): string =>
  `spectrum.terminal.${sessionId}`

const loadPersisted = (
  sessionId: SessionId,
): { paneOpen: boolean; paneHeightPx: number } => {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(sessionId)) ?? null
    if (!raw) return { paneOpen: false, paneHeightPx: DEFAULT_HEIGHT }
    const p = JSON.parse(raw) as { paneOpen?: boolean; paneHeightPx?: number }
    return {
      paneOpen: p.paneOpen ?? false,
      paneHeightPx: p.paneHeightPx ?? DEFAULT_HEIGHT,
    }
  } catch {
    return { paneOpen: false, paneHeightPx: DEFAULT_HEIGHT }
  }
}

const persist = (
  sessionId: SessionId,
  paneOpen: boolean,
  paneHeightPx: number,
): void => {
  try {
    globalThis.localStorage?.setItem(
      storageKey(sessionId),
      JSON.stringify({ paneOpen, paneHeightPx }),
    )
  } catch {
    /* storage unavailable — ignore */
  }
}

const blank = (): SessionTerminalState => ({
  tabs: [],
  activeTabId: null,
  paneOpen: false,
  paneHeightPx: DEFAULT_HEIGHT,
})

export const useTerminalStore = create<TerminalStoreState>()((set) => ({
  sessions: {},

  openPane: (sessionId) =>
    set((state) => {
      const existing = state.sessions[sessionId] ?? blank()
      const hasTabs = existing.tabs.length > 0
      const tabs: TerminalTab[] = hasTabs
        ? existing.tabs
        : [
            {
              id: newTabId(),
              title: "Terminal",
              exitCode: null,
              closed: false,
            },
          ]
      const firstTab = tabs[0]
      if (!firstTab) return state
      const paneOpen = true
      persist(sessionId, paneOpen, existing.paneHeightPx)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            tabs,
            paneOpen,
            activeTabId: existing.activeTabId ?? firstTab.id,
          },
        },
      }
    }),

  closePane: (sessionId) =>
    set((state) => {
      const existing = state.sessions[sessionId]
      if (!existing) return state
      persist(sessionId, false, existing.paneHeightPx)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, paneOpen: false },
        },
      }
    }),

  newTab: (sessionId) =>
    set((state) => {
      const existing = state.sessions[sessionId] ?? blank()
      const tab: TerminalTab = {
        id: newTabId(),
        title: "Terminal",
        exitCode: null,
        closed: false,
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            tabs: [...existing.tabs, tab],
            activeTabId: tab.id,
            paneOpen: true,
          },
        },
      }
    }),

  closeTab: (sessionId, tabId) =>
    set((state) => {
      const existing = state.sessions[sessionId]
      if (!existing) return state
      const tabs = existing.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        existing.activeTabId === tabId
          ? (tabs[0]?.id ?? null)
          : existing.activeTabId
      const paneOpen = tabs.length > 0 ? existing.paneOpen : false
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, tabs, activeTabId, paneOpen },
        },
      }
    }),

  selectTab: (sessionId, tabId) =>
    set((state) => {
      const existing = state.sessions[sessionId]
      if (!existing) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, activeTabId: tabId },
        },
      }
    }),

  setHeight: (sessionId, px) =>
    set((state) => {
      const existing = state.sessions[sessionId] ?? blank()
      // Clamp the pane between 80px (min drag) and 70% of viewport height (max sensible pane).
      // The brief's `70 * floor(innerHeight)` was effectively uncapped — fixed here.
      const max = Math.floor(0.7 * (globalThis.innerHeight ?? 1000))
      const clamped = Math.min(Math.max(px, 80), max)
      persist(sessionId, existing.paneOpen, clamped)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, paneHeightPx: clamped },
        },
      }
    }),

  setTabExit: (sessionId, tabId, exitCode) =>
    set((state) => {
      const existing = state.sessions[sessionId]
      if (!existing) return state
      const tabs = existing.tabs.map((t) =>
        t.id === tabId ? { ...t, exitCode, closed: true } : t,
      )
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, tabs },
        },
      }
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state
      const { [sessionId]: _removed, ...rest } = state.sessions
      try {
        globalThis.localStorage?.removeItem(storageKey(sessionId))
      } catch {
        /* storage unavailable — ignore */
      }
      return { sessions: rest }
    }),

  hydrate: (sessionId) =>
    set((state) => {
      if (state.sessions[sessionId]) return state
      const p = loadPersisted(sessionId)
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            tabs: [],
            activeTabId: null,
            paneOpen: p.paneOpen,
            paneHeightPx: p.paneHeightPx,
          },
        },
      }
    }),
}))
