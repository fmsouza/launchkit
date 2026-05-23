import type { ReactElement } from "react"
import type { ModelAlias } from "@launchkit/types"
import { AliasRow } from "../molecules/AliasRow"
import { EmptyState } from "../molecules/EmptyState"

export type AliasTableProps = {
  readonly aliases: readonly ModelAlias[]
  readonly providerNames: Readonly<Record<string, string>>
  readonly onEdit: (alias: string) => void
  readonly onDelete: (alias: string) => void
}

export const AliasTable = ({ aliases, providerNames, onEdit, onDelete }: AliasTableProps): ReactElement => {
  if (aliases.length === 0) {
    return <EmptyState title="No aliases yet" hint="Map an alias to a provider model." />
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Alias</th>
          <th>Provider</th>
          <th>Model</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {aliases.map((alias) => (
          <AliasRow
            key={alias.alias}
            alias={alias.alias}
            provider={providerNames[alias.providerId] ?? alias.providerId}
            model={alias.providerModel}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </tbody>
    </table>
  )
}
