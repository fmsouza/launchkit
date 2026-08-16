import type { ProviderAction } from "@spectrum/providers"
import { defaultActions } from "@spectrum/providers"
import type { ReactElement } from "react"
import { Badge } from "../atoms/Badge"
import { EmptyState } from "../molecules/EmptyState"
import { ProviderActionBar } from "../molecules/ProviderActionBar"

/**
 * Fallback used when a row doesn't carry catalog-sourced actions (e.g. a call site that
 * hasn't wired the catalog through yet) — the single source of truth for what a builtin
 * offers, not a re-typed copy of it.
 */
const DEFAULT_ACTIONS: readonly ProviderAction[] = defaultActions(true)

export type ProviderRow = {
  readonly id: string
  readonly name: string
  readonly sdkProvider: string
  /** Whether the provider's secret(s) are configured. */
  readonly secretSet: boolean
  /** Catalog-declared setup actions for this provider. Falls back to edit/secret when absent. */
  readonly actions?: readonly ProviderAction[]
}

export type ProviderListProps = {
  readonly providers: readonly ProviderRow[]
  /** Fires with the clicked provider's id and the actual descriptor-declared action, so the
   * page can dispatch on `action.kind` (including kinds this organism has no opinion about,
   * e.g. a plugin-contributed "flow"). */
  readonly onAction: (providerId: string, action: ProviderAction) => void
}

export const ProviderList = ({
  providers,
  onAction,
}: ProviderListProps): ReactElement => {
  if (providers.length === 0) {
    return (
      <EmptyState
        title="No providers yet"
        hint="Add a provider to start routing models."
      />
    )
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th>SDK</th>
          <th>API key</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => (
          <tr key={p.id}>
            <td>{p.name}</td>
            <td>
              <Badge tone="info">{p.sdkProvider}</Badge>
            </td>
            <td>
              <Badge tone={p.secretSet ? "success" : "neutral"}>
                {p.secretSet ? "Set" : "Not set"}
              </Badge>
            </td>
            <td className="lk-cell-actions">
              <ProviderActionBar
                actions={p.actions ?? DEFAULT_ACTIONS}
                context="provider"
                onAction={(action) => onAction(p.id, action)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
