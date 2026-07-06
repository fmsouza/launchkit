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

  it("stops preventing dragover defaults after uninstall", () => {
    const uninstall = installGlobalDropGuard(window)
    uninstall()
    const over = new Event("dragover", { cancelable: true, bubbles: true })
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
  })

  it("forces dropEffect none for drags outside drop targets", () => {
    const uninstall = installGlobalDropGuard(window)
    const dt = { dropEffect: "copy" }
    const over = new Event("dragover", { cancelable: true, bubbles: true })
    Object.defineProperty(over, "dataTransfer", { value: dt })
    window.dispatchEvent(over)
    expect(dt.dropEffect).toBe("none")
    uninstall()
  })
})
