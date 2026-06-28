import type { SessionId } from "@spectrum/types"
import { isOk } from "@spectrum/utils"
import { useCallback, useEffect, useMemo } from "react"
import {
  type SessionTerminalState,
  type TerminalTab,
  useTerminalStore,
} from "../stores/terminalStore"
import type { TerminalClient } from "../terminal/terminalClient"
import {
  type XtermFitAddon,
  type XtermTerminal,
  loadXterm,
} from "../terminal/xterm"
import { useNotifications } from "./useNotifications"

export interface UseTerminalInput {
  readonly sessionId: SessionId
  readonly terminalClient: TerminalClient
  readonly ipcClient: {
    resolveTerminalCwd(params: {
      sessionId: SessionId
    }): Promise<
      | { ok: true; value: { cwd: string } }
      | { ok: false; error: { kind: string; path?: string } }
    >
  }
  /**
   * Injectable for tests; defaults to the real Terminal constructor. Lazy-
   * loaded only on mount so test runs that never mount a pane never need
   * xterm in the module graph.
   */
  readonly createTerminal?: new (
    opts: object,
  ) => XtermTerminal
}

export interface UseTerminalResult {
  readonly paneOpen: boolean
  readonly paneHeightPx: number
  readonly tabs: ReturnType<
    typeof useTerminalStore.getState
  >["sessions"][string]["tabs"]
  readonly activeTabId: string | null
  openPane(): Promise<void>
  closePane(): void
  newTab(): Promise<void>
  closeTab(tabId: string): void
  selectTab(tabId: string): void
  sendInput(tabId: string, data: string): void
  resize(tabId: string, cols: number, rows: number): void
  /** Persist a new pane height (drag updates). */
  resizeHeight(px: number): void
  /**
   * Mount xterm into `container`; returns a cleanup that tears it down on
   * unmount/tab-swap. The pane relies on the returned cleanup to swap tabs
   * cleanly without leaking per-tab xterm instances.
   */
  mountTerminal(tabId: string, container: HTMLElement): () => void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

// Stable fallback for a session with no terminal state yet. MUST be a single
// frozen reference (not an inline object literal in the selector): zustand uses
// Object.is equality, so returning a fresh object each render — which happens
// after `clearSession` removes the entry — triggers an infinite re-render loop.
const EMPTY_SESSION_STATE: SessionTerminalState = Object.freeze({
  tabs: [] as TerminalTab[],
  activeTabId: null,
  paneOpen: false,
  paneHeightPx: 220,
})

// ---------------------------------------------------------------------------
// Module-level terminal registry.
//
// Keyed by tabId (client-generated UUIDs — globally unique across sessions).
// This lives OUTSIDE the React hook on purpose: `RunDetail` is keyed by
// sessionId and fully REMOUNTS when the active agent session changes, which
// would otherwise tear down per-hook refs and lose every terminal. Keeping the
// xterm instances + their PTY output subscriptions here means a session's
// terminals persist across active-session switches (and pane collapse). They
// are torn down ONLY by:
//   - closeTab (the user closes a tab),
//   - disposeTerminalSession (the agent session is canceled/removed), or
//   - process exit (the app is closed/killed).
const terms = new Map<string, XtermTerminal>()
const fits = new Map<string, XtermFitAddon>()
const resizeObservers = new Map<string, ResizeObserver>()
// Per-tab terminalClient listener disposers (onOutput/onExited/onError).
const unsubs = new Map<string, Array<() => void>>()

/**
 * Subscribe a tab to its PTY output/exit/error frames. Idempotent across
 * re-opens: the client keys listeners by (sessionId, tabId) and overwrites on
 * re-subscribe, so we simply replace the stored disposer array (calling an old
 * disposer would remove the freshly-registered listener). The output listener
 * writes into the module-level `terms` registry, so it keeps delivering bytes to
 * the (persistent) xterm even while the session is not the active view.
 */
const subscribeTab = (
  terminalClient: TerminalClient,
  sessionId: SessionId,
  tabId: string,
  notify: (n: { tone: "error"; message: string }) => void,
): void => {
  const offs: Array<() => void> = [
    terminalClient.onOutput(sessionId, tabId, (data) => {
      terms.get(tabId)?.write(atob(data))
    }),
    terminalClient.onExited(sessionId, tabId, (exitCode) => {
      useTerminalStore.getState().setTabExit(sessionId, tabId, exitCode)
    }),
    terminalClient.onError(sessionId, tabId, (message) => {
      notify({ tone: "error", message })
    }),
  ]
  unsubs.set(tabId, offs)
}

/** Tear down everything tracked for a single tab (idempotent). */
const teardownTab = (tabId: string): void => {
  resizeObservers.get(tabId)?.disconnect()
  resizeObservers.delete(tabId)
  for (const u of unsubs.get(tabId) ?? []) u()
  unsubs.delete(tabId)
  const term = terms.get(tabId)
  if (term) {
    term.dispose()
    terms.delete(tabId)
  }
  fits.delete(tabId)
}

/**
 * Kill every terminal belonging to an agent session — used when the session is
 * canceled/removed. Sends `term-close` to the backend PTY for each tab, disposes
 * the frontend xterm, and clears the session's tabs from the store.
 */
export const disposeTerminalSession = (
  terminalClient: TerminalClient,
  sessionId: SessionId,
): void => {
  const s = useTerminalStore.getState().sessions[sessionId]
  for (const tab of s?.tabs ?? []) {
    terminalClient.close({ sessionId, tabId: tab.id })
    teardownTab(tab.id)
  }
  useTerminalStore.getState().clearSession(sessionId)
}

/** Test-only: drop all registry state so module-level maps don't leak between tests. */
export const resetTerminalRegistryForTests = (): void => {
  for (const id of [...terms.keys()]) teardownTab(id)
  terms.clear()
  fits.clear()
  resizeObservers.clear()
  unsubs.clear()
}

export const useTerminal = (input: UseTerminalInput): UseTerminalResult => {
  const { notify } = useNotifications()
  const state = useTerminalStore(
    (s) => s.sessions[input.sessionId] ?? EMPTY_SESSION_STATE,
  )
  // Terminal instances + observers live in the module-level registry above so
  // they survive this hook's remount on active-session switch.

  const measureColsRows = useCallback(
    (container?: HTMLElement): { cols: number; rows: number } => {
      if (!container) return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
      try {
        const cols =
          Math.max(1, Math.floor(container.clientWidth / 9)) || DEFAULT_COLS
        const rows =
          Math.max(1, Math.floor(container.clientHeight / 18)) || DEFAULT_ROWS
        return { cols, rows }
      } catch {
        return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
      }
    },
    [],
  )

  // Recompute cols/rows via fit(), then forward to term-resize so the shell
  // reissues TIOCSWINSZ. Called on every container resize tick (pane drag,
  // window resize). Falls back to measurement if proposeDimensions is
  // unavailable (older addon or test stub).
  const refitAndResize = useCallback(
    (tabId: string): void => {
      const fit = fits.get(tabId)
      if (!fit) return
      fit.fit()
      const proposed = fit.proposeDimensions?.()
      const cols = proposed?.cols ?? DEFAULT_COLS
      const rows = proposed?.rows ?? DEFAULT_ROWS
      input.terminalClient.resize({
        sessionId: input.sessionId,
        tabId,
        cols,
        rows,
      })
    },
    [input],
  )

  const sendInput = useCallback(
    (tabId: string, data: string) => {
      input.terminalClient.input({
        sessionId: input.sessionId,
        tabId,
        data: btoa(data),
      })
    },
    [input],
  )

  const openPane = useCallback(async () => {
    useTerminalStore.getState().openPane(input.sessionId)
    const r = await input.ipcClient.resolveTerminalCwd({
      sessionId: input.sessionId,
    })
    if (!isOk(r)) {
      notify({
        tone: "error",
        message: "No working directory for this session",
      })
      return
    }
    const s = useTerminalStore.getState().sessions[input.sessionId]
    if (!s || s.tabs.length === 0) return
    const tab = s.tabs[0]
    if (!tab) return
    const { cols, rows } = measureColsRows()
    input.terminalClient.open({
      sessionId: input.sessionId,
      tabId: tab.id,
      cwd: r.value.cwd,
      cols,
      rows,
    })
    subscribeTab(input.terminalClient, input.sessionId, tab.id, notify)
  }, [input, measureColsRows, notify])

  const closePane = useCallback(() => {
    useTerminalStore.getState().closePane(input.sessionId)
    // intentionally NO term-close — background survival
  }, [input])

  const newTab = useCallback(async () => {
    useTerminalStore.getState().newTab(input.sessionId)
    const s = useTerminalStore.getState().sessions[input.sessionId]
    if (!s) return
    const tab = s.tabs[s.tabs.length - 1]
    if (!tab) return
    const r = await input.ipcClient.resolveTerminalCwd({
      sessionId: input.sessionId,
    })
    if (!isOk(r)) {
      notify({
        tone: "error",
        message: "No working directory for this session",
      })
      return
    }
    const { cols, rows } = measureColsRows()
    input.terminalClient.open({
      sessionId: input.sessionId,
      tabId: tab.id,
      cwd: r.value.cwd,
      cols,
      rows,
    })
    subscribeTab(input.terminalClient, input.sessionId, tab.id, notify)
  }, [input, measureColsRows, notify])

  const closeTab = useCallback(
    (tabId: string) => {
      input.terminalClient.close({ sessionId: input.sessionId, tabId })
      teardownTab(tabId)
      useTerminalStore.getState().closeTab(input.sessionId, tabId)
    },
    [input],
  )

  const selectTab = useCallback(
    (tabId: string) => {
      useTerminalStore.getState().selectTab(input.sessionId, tabId)
    },
    [input],
  )

  const resize = useCallback(
    (tabId: string, cols: number, rows: number) => {
      input.terminalClient.resize({
        sessionId: input.sessionId,
        tabId,
        cols,
        rows,
      })
    },
    [input],
  )

  const resizeHeight = useCallback(
    (px: number) => {
      useTerminalStore.getState().setHeight(input.sessionId, px)
    },
    [input.sessionId],
  )

  const mountTerminal = useCallback(
    (tabId: string, container: HTMLElement): (() => void) => {
      const existing = terms.get(tabId)
      if (existing) {
        // Re-mount into `container`. If the terminal has never been opened,
        // open it here. If it WAS opened but its element now lives in a stale
        // container (the pane was collapsed/reopened, or this tab's node was
        // recreated), re-parent the existing element into the live container —
        // xterm can't be re-`open()`ed, so move its DOM. Without this the
        // terminal stays orphaned in the detached node and the pane is blank.
        if (!existing.element) {
          existing.open(container)
        } else if (existing.element.parentElement !== container) {
          container.appendChild(existing.element)
        }
        fits.get(tabId)?.fit()
        return () => {
          // Background survival: the terminal stays mounted across tab swaps;
          // do nothing on cleanup unless the tab is being explicitly closed.
          // The pane's useEffect cleanup runs every tab switch, so leaving the
          // term open here preserves scrollback.
        }
      }
      // Statically-bundled xterm modules (see ../terminal/xterm). Loading must
      // not use a dynamic `require` — the webview is a `target: "browser"`
      // bundle with no runtime `require`, so a dynamic require throws and the
      // pane reports "Terminal renderer unavailable".
      const mods = loadXterm()
      const Ctor = input.createTerminal ?? mods.Terminal
      let term: XtermTerminal
      let fit: XtermFitAddon
      try {
        term = new Ctor({ convertEol: false })
        fit = new mods.FitAddon()
        term.loadAddon(fit)
      } catch {
        notify({
          tone: "error",
          message: "Terminal renderer unavailable",
        })
        return () => {}
      }
      try {
        term.loadAddon(new mods.WebglAddon())
      } catch {
        /* canvas/WebGL unavailable — canvas2d fallback */
      }
      try {
        term.loadAddon(new mods.ClipboardAddon())
      } catch {
        /* clipboard addon failed to init — noop */
      }
      try {
        term.loadAddon(new mods.SearchAddon())
      } catch {
        /* search addon failed to init — noop */
      }
      term.onData((data) => sendInput(tabId, data))
      terms.set(tabId, term)
      fits.set(tabId, fit)
      if (!term.element) term.open(container)
      fit.fit()
      // ResizeObserver on the container: pane drag + window resize both
      // reflow cols/rows here and forward to term-resize so node-pty
      // issues TIOCSWINSZ. The observer is kept alive while the tab is
      // open and disconnected in closeTab.
      const observer = new ResizeObserver(() => {
        refitAndResize(tabId)
      })
      observer.observe(container)
      resizeObservers.set(tabId, observer)
      return () => {
        // Background survival: xterm instances live in `terms` and
        // are torn down only by `closeTab`. The observer likewise stays
        // attached for the lifetime of the tab; `closeTab` disconnects it.
      }
    },
    [input, sendInput, notify, refitAndResize],
  )

  // hydrate persisted pane state on mount
  useEffect(() => {
    useTerminalStore.getState().hydrate(input.sessionId)
  }, [input.sessionId])

  return useMemo(
    () => ({
      paneOpen: state.paneOpen,
      paneHeightPx: state.paneHeightPx,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      openPane,
      closePane,
      newTab,
      closeTab,
      selectTab,
      sendInput,
      resize,
      resizeHeight,
      mountTerminal,
    }),
    [
      state,
      openPane,
      closePane,
      newTab,
      closeTab,
      selectTab,
      sendInput,
      resize,
      resizeHeight,
      mountTerminal,
    ],
  )
}
