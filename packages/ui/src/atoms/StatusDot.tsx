import type { ReactElement } from "react"

export type DotStatus = "on" | "off"

export type StatusDotProps = {
  readonly status: DotStatus
  readonly label: string
}

export const StatusDot = ({ status, label }: StatusDotProps): ReactElement => (
  <span role="img" aria-label={label} data-color={status === "on" ? "green" : "grey"} />
)
