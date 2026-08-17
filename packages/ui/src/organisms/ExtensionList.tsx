import type { ReactElement } from "react"
import { EmptyState } from "../molecules/EmptyState"
import type { ExtensionRowData } from "../molecules/ExtensionRow"
import { ExtensionRow } from "../molecules/ExtensionRow"

export type {
  ExtensionRowData,
  ExtensionSourceRow,
  ContributedProviderRow,
  ContributedProviderStatusRow,
} from "../molecules/ExtensionRow"

export type ExtensionListProps = {
  readonly extensions: readonly ExtensionRowData[]
  readonly onSetEnabled: (id: string, enabled: boolean) => void
  readonly onUpdate: (id: string) => void
  readonly onRemove: (id: string) => void
}

/** Dumb list: props in, callbacks out. Data enters at the page level. */
export const ExtensionList = ({
  extensions,
  onSetEnabled,
  onUpdate,
  onRemove,
}: ExtensionListProps): ReactElement => {
  if (extensions.length === 0) {
    return (
      <EmptyState
        title="No extensions yet"
        hint="Install an extension to contribute new providers."
      />
    )
  }
  return (
    <ul className="lk-extension-list">
      {extensions.map((ext) => (
        <ExtensionRow
          key={ext.id}
          extension={ext}
          onSetEnabled={onSetEnabled}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
    </ul>
  )
}
