import { useCallback } from "react"
import type { HarnessDefinition } from "@launchkit/types"
import { useIpcClient } from "../IpcClientContext"
import { type AsyncResource, useAsyncResource } from "./useAsyncResource"

export const useHarnesses = (): AsyncResource<readonly HarnessDefinition[]> => {
  const client = useIpcClient()
  const call = useCallback(() => client.getHarnesses(undefined), [client])
  return useAsyncResource(call)
}
