import type { ProviderAction } from "@spectrum/providers"
import type { ReactElement } from "react"
import { Badge } from "../atoms/Badge"
import { EmptyState } from "../molecules/EmptyState"
import { ProviderActionBar } from "../molecules/ProviderActionBar"

/**
 * Fallback used when a row doesn't carry catalog-sourced actions (e.g. a call site that
 * hasn't wired the catalog through yet). Mirrors `defaultActions(true)` from
 * `@spectrum/providers` — kept local so this stays a pure, IO-free organism.
 */
const DEFAULT_ACTIONS: readonly ProviderAction[] = [
  { kind: "edit-config", id: "edit", label: "Edit", context: "both" },
  { kind: "set-secrets", id: "secrets", label: "Set secret", context: "both" },
]

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
  readonly onSetSecret: (providerId: string) => void
  readonly onEdit: (providerId: string) => void
}

export const ProviderList = ({
  providers,
  onSetSecret,
  onEdit,
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
                onAction={(action) => {
                  if (action.kind === "edit-config") {
                    onEdit(p.id)
                    return
                  }
                  if (action.kind === "set-secrets") {
                    onSetSecret(p.id)
                    return
                  }
                  // "flow" isn't reachable from a builtin row yet — no builtin declares one
                  // and this organism has no handler for it until a later plan wires it up.
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
