import type { ModelRoute } from "@spectrum/types"
import type { ReactElement } from "react"
import { EmptyState } from "../molecules/EmptyState"
import { ModelRow } from "../molecules/ModelRow"

export type ModelTableProps = {
  readonly models: readonly ModelRoute[]
  readonly providerNames: Readonly<Record<string, string>>
  readonly onEdit: (id: string) => void
  readonly onDelete: (id: string) => void
}

const capabilitiesLabel = (m: ModelRoute): string => {
  const img = m.attachments.image === true
  const pdf = m.attachments.pdf === true
  if (img && pdf) return "images + PDFs"
  if (img) return "images"
  if (pdf) return "PDFs"
  return "—"
}

export const ModelTable = ({
  models,
  providerNames,
  onEdit,
  onDelete,
}: ModelTableProps): ReactElement => {
  if (models.length === 0) {
    return (
      <EmptyState
        title="No models yet"
        hint="Add a provider model to pick when starting a session."
      />
    )
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th>Model</th>
          <th>Aliases</th>
          <th>Attachments</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <ModelRow
            key={String(m.id)}
            id={String(m.id)}
            provider={
              providerNames[String(m.providerId)] ?? String(m.providerId)
            }
            model={m.providerModel}
            aliases={(m.aliases ?? []).join(", ")}
            capabilities={capabilitiesLabel(m)}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </tbody>
    </table>
  )
}
