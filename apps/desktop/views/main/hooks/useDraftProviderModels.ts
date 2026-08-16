import type { IpcError } from "@spectrum/ipc"
import type { DiscoveredModel, ProviderKey } from "@spectrum/types"
import { useCallback, useState } from "react"
import { useIpcClient } from "../IpcClientContext"

export type DraftDiscoverInput = {
  readonly sdkProvider: ProviderKey
  readonly config: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
}

export type UseDraftProviderModels = {
  readonly models: readonly DiscoveredModel[]
  readonly loading: boolean
  readonly error: IpcError | undefined
  readonly discover: (
    input: DraftDiscoverInput,
  ) => Promise<readonly DiscoveredModel[]>
  readonly reset: () => void
}

/** Imperative model discovery for an UN-SAVED provider (driven by inline draft inputs). */
export const useDraftProviderModels = (): UseDraftProviderModels => {
  const client = useIpcClient()
  const [models, setModels] = useState<readonly DiscoveredModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<IpcError | undefined>(undefined)

  const discover = useCallback(
    async (input: DraftDiscoverInput): Promise<readonly DiscoveredModel[]> => {
      setLoading(true)
      setError(undefined)
      const r = await client.listProviderModelsDraft(input)
      if (r.ok) {
        setModels(r.value.models)
        setLoading(false)
        return r.value.models
      }
      setModels([])
      setError(r.error)
      setLoading(false)
      return []
    },
    [client],
  )

  const reset = useCallback((): void => {
    setModels([])
    setError(undefined)
    setLoading(false)
  }, [])

  return { models, loading, error, discover, reset }
}
