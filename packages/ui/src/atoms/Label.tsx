import type { ReactElement, ReactNode } from "react"

export type LabelProps = {
  readonly htmlFor: string
  readonly children: ReactNode
}

export const Label = ({ htmlFor, children }: LabelProps): ReactElement => (
  <label htmlFor={htmlFor}>{children}</label>
)
