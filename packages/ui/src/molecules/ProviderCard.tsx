import type { ReactElement } from "react"
import type { Provider } from "@launchkit/types"
import { Badge } from "../atoms/Badge"
import { Button } from "../atoms/Button"

/** Secret-free display projection of a Provider — never carries `secrets`/`config`. */
export type ProviderDisplay = Pick<Provider, "id" | "name" | "sdkProvider">

export type ProviderCardProps = {
  readonly provider: ProviderDisplay
  readonly onLaunch?: (providerId: string) => void
}

export const ProviderCard = ({ provider, onLaunch }: ProviderCardProps): ReactElement => (
  <article>
    <h3>{provider.name}</h3>
    <Badge tone="info">{provider.sdkProvider}</Badge>
    {onLaunch !== undefined ? (
      <Button onClick={() => onLaunch(provider.id)}>Launch</Button>
    ) : null}
  </article>
)
