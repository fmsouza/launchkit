import type { ReactElement, ReactNode } from "react"
import { Label } from "../atoms/Label"

export type FormFieldProps = {
  readonly id: string
  readonly label: string
  readonly children: ReactNode
  readonly error?: string
}

export const FormField = ({ id, label, children, error }: FormFieldProps): ReactElement => (
  <div>
    <Label htmlFor={id}>{label}</Label>
    {children}
    {error !== undefined ? <p role="alert">{error}</p> : null}
  </div>
)
