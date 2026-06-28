export type TooltipPlacement = "top" | "bottom" | "left" | "right"

export interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}
export interface Viewport {
  readonly width: number
  readonly height: number
}
export interface TooltipPosition {
  readonly placement: TooltipPlacement
  readonly top: number
  readonly left: number
}

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v))

const opposite: Record<TooltipPlacement, TooltipPlacement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
}

/** Does the bubble fit on `side` of the trigger within the viewport (+gap)? */
const fits = (
  side: TooltipPlacement,
  trigger: Rect,
  bubble: Rect,
  vp: Viewport,
  gap: number,
): boolean => {
  if (side === "top") return trigger.top - gap - bubble.height >= 0
  if (side === "bottom")
    return trigger.top + trigger.height + gap + bubble.height <= vp.height
  if (side === "left") return trigger.left - gap - bubble.width >= 0
  return trigger.left + trigger.width + gap + bubble.width <= vp.width
}

/**
 * Resolve a tooltip bubble's viewport-fixed position. Prefers `preferred`,
 * flips to the opposite side when the preferred side would overflow, and clamps
 * the cross-axis into the viewport with `margin`. Returns top-left coordinates;
 * the caller applies them with `position: fixed` and NO transform.
 */
export const resolveTooltipPosition = (
  trigger: Rect,
  bubble: Rect,
  viewport: Viewport,
  preferred: TooltipPlacement,
  gap = 8,
  margin = 4,
): TooltipPosition => {
  const placement =
    fits(preferred, trigger, bubble, viewport, gap) ||
    !fits(opposite[preferred], trigger, bubble, viewport, gap)
      ? preferred
      : opposite[preferred]

  const centerX = trigger.left + trigger.width / 2
  const centerY = trigger.top + trigger.height / 2

  let top: number
  let left: number
  if (placement === "top") {
    top = trigger.top - gap - bubble.height
    left = centerX - bubble.width / 2
  } else if (placement === "bottom") {
    top = trigger.top + trigger.height + gap
    left = centerX - bubble.width / 2
  } else if (placement === "left") {
    left = trigger.left - gap - bubble.width
    top = centerY - bubble.height / 2
  } else {
    left = trigger.left + trigger.width + gap
    top = centerY - bubble.height / 2
  }

  return {
    placement,
    top: clamp(top, margin, viewport.height - bubble.height - margin),
    left: clamp(left, margin, viewport.width - bubble.width - margin),
  }
}
