import { THINKING_EFFORTS, type ThinkingEffort } from "@spectrum/agent-events"
import { type ReactElement, useState } from "react"
import { Icon } from "../atoms/Icon"

export type ThinkingEffortSelectorProps = {
  readonly effort: ThinkingEffort
  readonly onChange: (effort: ThinkingEffort) => void
  readonly disabled?: boolean
  /** Tiers to render; defaults to all six in THINKING_EFFORTS order. */
  readonly supported?: readonly ThinkingEffort[]
}

const labelFor = (e: ThinkingEffort): string =>
  e.charAt(0).toUpperCase() + e.slice(1)

export const ThinkingEffortSelector = ({
  effort,
  onChange,
  disabled = false,
  supported = THINKING_EFFORTS,
}: ThinkingEffortSelectorProps): ReactElement => {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="lk-mode-selector"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="lk-mode-selector__pill"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {labelFor(effort)}
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div className="lk-mode-selector__menu" role="menu">
          {supported.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={e === effort}
              className="lk-mode-selector__item"
              onClick={() => {
                setOpen(false)
                if (e !== effort) onChange(e)
              }}
            >
              {labelFor(e)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
