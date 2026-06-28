import { type ReactElement, useEffect, useRef } from "react"
import { IconButton } from "../atoms/IconButton"
import { type TerminalTabItem, TerminalTabs } from "../molecules/TerminalTabs"

export interface TerminalPaneProps {
  readonly tabs: readonly TerminalTabItem[]
  readonly activeTabId: string | null
  readonly paneHeightPx: number
  /**
   * Collapsed state. When true the pane is kept MOUNTED but visually hidden
   * (`hidden` attribute) — so the per-tab xterm DOM and the underlying PTYs
   * survive a collapse. Unmounting instead would orphan the terminals and kill
   * the running sessions.
   */
  readonly hidden?: boolean
  readonly onSelectTab: (tabId: string) => void
  readonly onNewTab: () => void
  readonly onCloseTab: (tabId: string) => void
  readonly onResizeHeight: (px: number) => void
  readonly onClose: () => void
  /**
   * Host mounts the xterm Terminal for `tabId` into `container` and returns a
   * cleanup. Each tab gets its OWN persistent container (below), so every tab
   * is an independent terminal session — switching tabs is pure show/hide.
   */
  readonly mountTerminal: (tabId: string, container: HTMLElement) => () => void
}

export const TerminalPane = (props: TerminalPaneProps): ReactElement => {
  // Per-tab mount node + cleanup. Each tab keeps its own container for its whole
  // lifetime so the xterm instance is never re-parented on a tab swap.
  const containers = useRef(new Map<string, HTMLDivElement>())
  const cleanups = useRef(new Map<string, () => void>())

  useEffect(() => {
    // Mount any tab that has a container but isn't mounted yet.
    for (const t of props.tabs) {
      const el = containers.current.get(t.id)
      if (el && !cleanups.current.has(t.id)) {
        cleanups.current.set(t.id, props.mountTerminal(t.id, el))
      }
    }
    // Tear down terminals for tabs that were closed.
    const live = new Set(props.tabs.map((t) => t.id))
    for (const [id, cleanup] of cleanups.current) {
      if (!live.has(id)) {
        cleanup()
        cleanups.current.delete(id)
        containers.current.delete(id)
      }
    }
  }, [props.tabs, props.mountTerminal])

  // Run every cleanup when the pane itself unmounts (e.g. leaving the run view).
  useEffect(() => {
    const map = cleanups.current
    return () => {
      for (const cleanup of map.values()) cleanup()
      map.clear()
    }
  }, [])

  return (
    <section
      className="lk-terminal-pane"
      hidden={props.hidden}
      style={{ height: props.paneHeightPx }}
    >
      <TerminalTabs
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        onSelectTab={props.onSelectTab}
        onNewTab={props.onNewTab}
        onCloseTab={props.onCloseTab}
        onResizeHeight={props.onResizeHeight}
        currentHeightPx={props.paneHeightPx}
      />
      <div className="lk-terminal-pane__close">
        <IconButton label="Close terminal pane" onClick={props.onClose}>
          ▾
        </IconButton>
      </div>
      <div className="lk-terminal-pane__screens">
        {props.tabs.map((t) => (
          <div
            key={t.id}
            className="lk-terminal-pane__screen"
            ref={(el) => {
              if (el) containers.current.set(t.id, el)
            }}
            style={{
              display: t.id === props.activeTabId ? "block" : "none",
            }}
            aria-hidden={t.id === props.activeTabId ? undefined : true}
          />
        ))}
      </div>
    </section>
  )
}
