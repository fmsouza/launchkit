import { useId, useLayoutEffect, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { createPortal } from "react-dom"
import { resolveTooltipPosition } from "./tooltip-position"

export type { TooltipPlacement } from "./tooltip-position"
import type { TooltipPlacement } from "./tooltip-position"

export type TooltipProps = {
  readonly label: string
  readonly placement?: TooltipPlacement
  readonly className?: string
  readonly children: ReactNode
}

/**
 * Wraps a trigger and reveals a `role="tooltip"` bubble on hover/focus.
 *
 * The bubble is portaled to `document.body` and positioned with
 * `position: fixed` from the trigger's `getBoundingClientRect()`. This escapes
 * every ancestor's `overflow: hidden|auto` — the bubble renders over the whole
 * window no matter where the trigger lives (e.g. inside a scrollable nav rail).
 * `mouseOver`/`mouseOut` (which bubble) let the wrapper react to events on the
 * inner trigger; `focus`/`blur` cover keyboard users; Escape dismisses it.
 * An optional `className` is appended to the root so the wrapper can be made a
 * constrained flex item (e.g. to truncate long trigger text).
 */
export const Tooltip = ({
  label,
  placement = "top",
  className,
  children,
}: TooltipProps): ReactElement => {
  const id = useId()
  const [open, setOpen] = useState<boolean>(false)
  const triggerRef = useRef<HTMLSpanElement | null>(null)

  // Position the ported bubble whenever it is shown. useLayoutEffect runs
  // before paint so the bubble never flashes in the wrong spot.
  useLayoutEffect(() => {
    if (!open) return
    const bubble = document.getElementById(id)
    const trigger = triggerRef.current
    if (bubble === null || trigger === null) return
    const t = trigger.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()
    const pos = resolveTooltipPosition(
      { top: t.top, left: t.left, width: t.width, height: t.height },
      { top: 0, left: 0, width: b.width, height: b.height },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
    )
    bubble.style.top = `${pos.top}px`
    bubble.style.left = `${pos.left}px`
    bubble.dataset.placement = pos.placement
  }, [id, open, placement])

  return (
    <span
      ref={triggerRef}
      className={
        className === undefined ? "lk-tooltip" : `lk-tooltip ${className}`
      }
      data-placement={placement}
      onMouseOver={() => setOpen(true)}
      onMouseOut={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false)
      }}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {open
        ? createPortal(
            <span
              role="tooltip"
              id={id}
              className="lk-tooltip__bubble"
              style={{ position: "fixed", transform: "none" }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
