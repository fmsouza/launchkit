import type { ProviderAction } from "@spectrum/providers"
import type { ReactElement } from "react"
import { Button } from "../atoms/Button"

export type ProviderActionBarProps = {
  readonly actions: readonly ProviderAction[]
  readonly context: "create" | "provider"
  readonly onAction: (action: ProviderAction) => void
}

/** Renders one Button per action available in the current context. Pure, no fetching. */
export const ProviderActionBar = ({
  actions,
  context,
  onAction,
}: ProviderActionBarProps): ReactElement => (
  <>
    {actions
      .filter((a) => a.context === context || a.context === "both")
      .map((a) => (
        <Button key={a.id} variant="secondary" onClick={() => onAction(a)}>
          {a.label}
        </Button>
      ))}
  </>
)
