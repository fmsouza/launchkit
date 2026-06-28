import { describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { TerminalPane, type TerminalPaneProps } from "./TerminalPane"

const tab = (id: string) => ({
  id,
  title: "Terminal",
  exitCode: null,
  closed: false,
})

const baseProps = (
  over: Partial<TerminalPaneProps> = {},
): TerminalPaneProps => ({
  tabs: [tab("t1")],
  activeTabId: "t1",
  paneHeightPx: 220,
  onSelectTab: () => {},
  onNewTab: () => {},
  onCloseTab: () => {},
  onResizeHeight: () => {},
  onClose: () => {},
  mountTerminal: () => () => {},
  ...over,
})

describe("TerminalPane", () => {
  it("renders one screen container per tab and mounts each tab into its own node", () => {
    const mounted: Array<{ tabId: string; container: HTMLElement }> = []
    render(
      <TerminalPane
        {...baseProps({
          tabs: [tab("t1"), tab("t2")],
          activeTabId: "t2",
          mountTerminal: (tabId, container) => {
            mounted.push({ tabId, container })
            return () => {}
          },
        })}
      />,
    )
    const screens = document.querySelectorAll(".lk-terminal-pane__screen")
    // One mount node per tab (not a single shared container).
    expect(screens.length).toBe(2)
    // Each tab is mounted into its OWN container element.
    expect(mounted.map((m) => m.tabId).sort()).toEqual(["t1", "t2"])
    expect(mounted[0]?.container).not.toBe(mounted[1]?.container)
    cleanup()
  })

  it("shows only the active tab's screen and hides the others", () => {
    render(
      <TerminalPane
        {...baseProps({ tabs: [tab("t1"), tab("t2")], activeTabId: "t2" })}
      />,
    )
    const screens = Array.from(
      document.querySelectorAll<HTMLElement>(".lk-terminal-pane__screen"),
    )
    const visible = screens.filter((s) => s.style.display !== "none")
    expect(visible.length).toBe(1)
    cleanup()
  })

  it("hides the whole pane (hidden attr) without unmounting the screens when collapsed", () => {
    render(<TerminalPane {...baseProps({ hidden: true })} />)
    const pane = document.querySelector<HTMLElement>(".lk-terminal-pane")
    expect(pane).not.toBeNull()
    expect(pane?.hidden).toBe(true)
    // The screen container stays mounted so the xterm DOM + PTY survive.
    expect(document.querySelectorAll(".lk-terminal-pane__screen").length).toBe(
      1,
    )
    cleanup()
  })
})
