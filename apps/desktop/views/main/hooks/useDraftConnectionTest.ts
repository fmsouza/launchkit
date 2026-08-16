import type { IpcError } from "@spectrum/ipc"
import type { SdkProvider } from "@spectrum/types"
import { useCallback, useState } from "react"
import { useIpcClient } from "../IpcClientContext"

export type DraftTestInput = {
  readonly sdkProvider: SdkProvider
  readonly config: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
  readonly providerModel: string
}

export type UseDraftConnectionTest = {
  readonly result:
    | { readonly ok: boolean; readonly latencyMs: number }
    | undefined
  readonly testing: boolean
  readonly error: IpcError | undefined
  readonly test: (input: DraftTestInput) => Promise<void>
  readonly reset: () => void
}

/** Imperative connectivity probe for an UN-SAVED provider (inline draft inputs). */
export const useDraftConnectionTest = (): UseDraftConnectionTest => {
  const client = useIpcClient()
  const [result, setResult] =
    useState<UseDraftConnectionTest["result"]>(undefined)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<IpcError | undefined>(undefined)

  const test = useCallback(
    async (input: DraftTestInput): Promise<void> => {
      setTesting(true)
      setError(undefined)
      setResult(undefined)
      const r = await client.testProviderDraft(input)
      if (r.ok) setResult(r.value)
      else setError(r.error)
      setTesting(false)
    },
    [client],
  )

  const reset = useCallback((): void => {
    setResult(undefined)
    setError(undefined)
    setTesting(false)
  }, [])

  return { result, testing, error, test, reset }
}
