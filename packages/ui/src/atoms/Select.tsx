import type { ReactElement } from "react"

export type SelectOption = {
  readonly value: string
  readonly label: string
}

export type SelectProps = {
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
  readonly id?: string
  readonly disabled?: boolean
}

export const Select = ({ value, options, onChange, id, disabled = false }: SelectProps): ReactElement => (
  <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
)
