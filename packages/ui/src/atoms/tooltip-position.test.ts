import { describe, expect, it } from "bun:test"
import { resolveTooltipPosition } from "./tooltip-position"

const vp = { width: 1000, height: 800 }
const bubble = { top: 0, left: 0, width: 100, height: 40 }

describe("resolveTooltipPosition", () => {
  it("places above and centered when top fits", () => {
    const trigger = { top: 400, left: 480, width: 40, height: 20 }
    const r = resolveTooltipPosition(trigger, bubble, vp, "top", 8, 4)
    expect(r.placement).toBe("top")
    expect(r.top).toBe(400 - 40 - 8) // above trigger by height + gap
    expect(r.left).toBe(480 + 20 - 50) // centered: triggerCenterX - bubbleWidth/2
  })

  it("flips to bottom when there is no room above", () => {
    const trigger = { top: 5, left: 480, width: 40, height: 20 }
    const r = resolveTooltipPosition(trigger, bubble, vp, "top", 8, 4)
    expect(r.placement).toBe("bottom")
    expect(r.top).toBe(5 + 20 + 8) // below trigger by trigger height + gap
  })

  it("clamps left into the viewport at the right edge", () => {
    const trigger = { top: 400, left: 980, width: 20, height: 20 }
    const r = resolveTooltipPosition(trigger, bubble, vp, "top", 8, 4)
    expect(r.left).toBe(1000 - 100 - 4) // viewport.width - bubbleWidth - margin
  })

  it("clamps left into the viewport at the left edge", () => {
    const trigger = { top: 400, left: 0, width: 20, height: 20 }
    const r = resolveTooltipPosition(trigger, bubble, vp, "top", 8, 4)
    expect(r.left).toBe(4) // margin
  })

  it("flips left to right when there is no room on the left", () => {
    const trigger = { top: 400, left: 5, width: 20, height: 20 }
    const r = resolveTooltipPosition(trigger, bubble, vp, "left", 8, 4)
    expect(r.placement).toBe("right")
    expect(r.left).toBe(5 + 20 + 8) // right of trigger by trigger width + gap
  })
})
