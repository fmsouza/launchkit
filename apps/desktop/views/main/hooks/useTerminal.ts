import type { SessionId } from "@spectrum/types"
import { isOk } from "@spectrum/utils"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTerminalStore } from "../stores/terminalStore"
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

export const useTerminal = (input: UseTerminalInput): UseTerminalResult => {
  const { notify } = useNotifications()
  const state = useTerminalStore(
    (s) =>
      s.sessions[input.sessionId] ?? {
        tabs: [],
        activeTabId: null,
        paneOpen: false,
        paneHeightPx: 220,
      },
  )
  // xterm instances keyed by tabId — kept alive while paneOpen=false for
  // scrollback survival; disposed only on explicit closeTab.
  const terms = useRef(new Map<string, XtermTerminal>())
  const fits = useRef(new Map<string, XtermFitAddon>())
  // Per-tab ResizeObservers — disconnect on closeTab so the observer dies
  // with the terminal. Each observer calls fit() and forwards the new
  // cols/rows to term-resize, so pane drag + window resize both reach
  // node-pty's TIOCSWINSZ.
  const resizeObservers = useRef(new Map<string, ResizeObserver>())

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
      const fit = fits.current.get(tabId)
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
    input.terminalClient.onOutput(input.sessionId, tab.id, (data) => {
      terms.current.get(tab.id)?.write(atob(data))
    })
    input.terminalClient.onExited(input.sessionId, tab.id, (exitCode) => {
      useTerminalStore.getState().setTabExit(input.sessionId, tab.id, exitCode)
    })
    input.terminalClient.onError(input.sessionId, tab.id, (message) => {
      notify({ tone: "error", message })
    })
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
    input.terminalClient.onOutput(input.sessionId, tab.id, (data) =>
      terms.current.get(tab.id)?.write(atob(data)),
    )
    input.terminalClient.onExited(input.sessionId, tab.id, (exitCode) =>
      useTerminalStore.getState().setTabExit(input.sessionId, tab.id, exitCode),
    )
    input.terminalClient.onError(input.sessionId, tab.id, (message) =>
      notify({ tone: "error", message }),
    )
  }, [input, measureColsRows, notify])

  const closeTab = useCallback(
    (tabId: string) => {
      input.terminalClient.close({ sessionId: input.sessionId, tabId })
      const observer = resizeObservers.current.get(tabId)
      if (observer) {
        observer.disconnect()
        resizeObservers.current.delete(tabId)
      }
      const term = terms.current.get(tabId)
      if (term) {
        term.dispose()
        terms.current.delete(tabId)
        fits.current.delete(tabId)
      }
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
      const existing = terms.current.get(tabId)
      if (existing) {
        if (!existing.element) existing.open(container)
        fits.current.get(tabId)?.fit()
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
      terms.current.set(tabId, term)
      fits.current.set(tabId, fit)
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
      resizeObservers.current.set(tabId, observer)
      return () => {
        // Background survival: xterm instances live in `terms.current` and
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
