import { describe, expect, it } from "bun:test"
import { installGlobalDropGuard } from "./drop-guard"

describe("installGlobalDropGuard", () => {
  it("prevents the webview default for drags and drops that reach the window", () => {
    const uninstall = installGlobalDropGuard(window)
    const over = new Event("dragover", { cancelable: true, bubbles: true })
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new Event("drop", { cancelable: true, bubbles: true })
    window.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    uninstall()
  })

  it("stops preventing defaults after uninstall", () => {
    const uninstall = installGlobalDropGuard(window)
    uninstall()
    const drop = new Event("drop", { cancelable: true, bubbles: true })
    window.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(false)
  })
})
