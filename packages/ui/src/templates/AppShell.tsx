import type { ReactElement, ReactNode } from "react"
import { BrandMark } from "../atoms/BrandMark"
import { Icon } from "../atoms/Icon"
import { Spinner } from "../atoms/Spinner"
import { StatusDot } from "../atoms/StatusDot"
import { Tooltip } from "../atoms/Tooltip"
import { RailItem } from "../molecules/RailItem"

export type AppMode = "sessions" | "settings"

export type AppShellProps = {
  readonly mode: AppMode
  readonly onModeChange: (mode: AppMode) => void
  readonly proxyRunning: boolean
  readonly proxyPort?: number | undefined
  /** Backend is (re)connecting or a run is starting — show a discreet rail spinner. */
  readonly activity?: boolean
  readonly master: ReactNode
  readonly detail: ReactNode
}

export const AppShell = ({
  mode,
  onModeChange,
  proxyRunning,
  proxyPort,
  activity = false,
  master,
  detail,
}: AppShellProps): ReactElement => {
  const proxyLabel = proxyRunning
    ? `Proxy running on port ${proxyPort ?? "?"}`
    : "Proxy stopped"
  return (
    <div className="lk-shell">
      <nav aria-label="Primary">
        <span data-app-icon="">
          <BrandMark variant="mono-white" size={28} title="Spectrum" />
        </span>
        <ul>
          <RailItem
            label="Sessions"
            active={mode === "sessions"}
            onClick={() => onModeChange("sessions")}
          >
            <Icon name="sessions" />
          </RailItem>
          <RailItem
            label="Settings"
            active={mode === "settings"}
            onClick={() => onModeChange("settings")}
          >
            <Icon name="settings" />
          </RailItem>
        </ul>
        <div className="lk-rail-status">
          {activity ? <Spinner label="Connecting…" /> : null}
          <Tooltip label={proxyLabel}>
            <StatusDot status={proxyRunning ? "on" : "off"} label={proxyLabel} />
          </Tooltip>
        </div>
      </nav>
      <nav aria-label={mode === "sessions" ? "Sessions" : "Settings"}>
        {master}
      </nav>
      <main>{detail}</main>
    </div>
  )
}
