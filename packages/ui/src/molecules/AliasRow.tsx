import type { ReactElement } from "react"
import { Button } from "../atoms/Button"

export type AliasRowProps = {
  readonly alias: string
  readonly provider: string
  readonly model: string
  readonly onEdit: (alias: string) => void
  readonly onDelete: (alias: string) => void
}

export const AliasRow = ({ alias, provider, model, onEdit, onDelete }: AliasRowProps): ReactElement => (
  <tr>
    <td>{alias}</td>
    <td>{provider}</td>
    <td>{model}</td>
    <td>
      <Button variant="secondary" onClick={() => onEdit(alias)}>Edit</Button>
      <Button variant="danger" onClick={() => onDelete(alias)}>Delete</Button>
    </td>
  </tr>
)
