import type { ReactElement, ReactNode } from "react"

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger"

export type BadgeProps = {
  readonly tone: BadgeTone
  readonly children: ReactNode
}

export const Badge = ({ tone, children }: BadgeProps): ReactElement => (
  <span data-tone={tone}>{children}</span>
)
