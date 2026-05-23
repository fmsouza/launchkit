import type { ReactElement } from "react"

export type EmptyStateProps = {
  readonly title: string
  readonly hint: string
}

export const EmptyState = ({ title, hint }: EmptyStateProps): ReactElement => (
  <div>
    <h2>{title}</h2>
    <p>{hint}</p>
  </div>
)
