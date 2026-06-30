import { useCallback, useEffect, useState } from "react"
import { useIpcClient } from "../IpcClientContext"
import { useNotifications } from "./useNotifications"

export type UseSessionNamingSettings = {
  /** `undefined` while the initial load is in flight; `null` = off; a `string` = the selected ModelId. */
  readonly modelId: string | null | undefined
  readonly save: (next: string | null) => Promise<void>
}

/**
 * Loads the AI session-naming model id on mount and exposes a `save` that
 * persists it via IPC. Load errors are silent (the picker stays empty until a
 * refetch succeeds); save errors toast a sticky `error` — mirrors
 * `useTimeoutSettings`. No toast on success (routine CRUD).
 */
export const useSessionNamingSettings = (): UseSessionNamingSettings => {
  const client = useIpcClient()
  const { notify } = useNotifications()

  const [modelId, setModelId] = useState<string | null | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    const r = await client.getSessionNamingSettings(undefined)
    if (r.ok) setModelId(r.value.sessionNameModelId)
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (next: string | null): Promise<void> => {
      const r = await client.updateSessionNamingSettings({
        sessionNameModelId: next,
      })
      if (r.ok) {
        setModelId(next)
      } else {
        notify({
          tone: "error",
          message: "Couldn't save the session naming setting.",
        })
      }
    },
    [client, notify],
  )

  return { modelId, save }
}
