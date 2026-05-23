import { useCallback } from "react"
import type { ProviderView } from "@launchkit/ipc"
import { useIpcClient } from "../IpcClientContext"
import { type AsyncResource, useAsyncResource } from "./useAsyncResource"

/** Loads the secret-free provider views (the only provider shape the GUI sees). */
export const useProviders = (): AsyncResource<readonly ProviderView[]> => {
  const client = useIpcClient()
  const call = useCallback(() => client.getProviders(undefined), [client])
  return useAsyncResource(call)
}
