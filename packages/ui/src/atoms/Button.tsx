import type { ReactElement, ReactNode } from "react"

export type ButtonVariant = "primary" | "secondary" | "danger"

export type ButtonProps = {
  readonly children: ReactNode
  readonly onClick: () => void
  readonly variant?: ButtonVariant
  readonly disabled?: boolean
}

export const Button = ({ children, onClick, variant = "primary", disabled = false }: ButtonProps): ReactElement => (
  <button type="button" data-variant={variant} disabled={disabled} onClick={() => onClick()}>
    {children}
  </button>
)
