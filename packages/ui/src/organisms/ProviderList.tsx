import type { ReactElement } from "react"
import { Button } from "../atoms/Button"
import { ProviderCard } from "../molecules/ProviderCard"
import type { ProviderDisplay } from "../molecules/ProviderCard"
import { EmptyState } from "../molecules/EmptyState"

export type ProviderListProps = {
  readonly providers: readonly ProviderDisplay[]
  readonly onAdd: () => void
  readonly onSelect: (providerId: string) => void
}

export const ProviderList = ({ providers, onAdd, onSelect }: ProviderListProps): ReactElement => (
  <section>
    <Button onClick={() => onAdd()}>Add provider</Button>
    {providers.length === 0 ? (
      <EmptyState title="No providers yet" hint="Add a provider to start routing models." />
    ) : (
      <ul>
        {providers.map((provider) => (
          <li key={provider.id}>
            <ProviderCard provider={provider} />
            <Button variant="secondary" onClick={() => onSelect(provider.id)}>{`Select ${provider.name}`}</Button>
          </li>
        ))}
      </ul>
    )}
  </section>
)
