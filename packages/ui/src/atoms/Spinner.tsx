import type { ReactElement } from "react"

export type SpinnerProps = {
  readonly label: string
}

export const Spinner = ({ label }: SpinnerProps): ReactElement => (
  <span role="status" aria-label={label} aria-busy="true" />
)
