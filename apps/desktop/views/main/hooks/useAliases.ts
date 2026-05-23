import { useCallback } from "react"
import type { ModelAlias } from "@launchkit/types"
import { useIpcClient } from "../IpcClientContext"
import { type AsyncResource, useAsyncResource } from "./useAsyncResource"

export const useAliases = (): AsyncResource<readonly ModelAlias[]> => {
  const client = useIpcClient()
  const call = useCallback(() => client.getAliases(undefined), [client])
  return useAsyncResource(call)
}
