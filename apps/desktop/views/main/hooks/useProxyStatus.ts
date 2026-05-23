import { useCallback } from "react"
import type { IpcMethods } from "@launchkit/ipc"
import { useIpcClient } from "../IpcClientContext"
import { type AsyncResource, useAsyncResource } from "./useAsyncResource"

export type ProxyStatus = IpcMethods["getProxyStatus"]["result"]

export const useProxyStatus = (): AsyncResource<ProxyStatus> => {
  const client = useIpcClient()
  const call = useCallback(() => client.getProxyStatus(undefined), [client])
  return useAsyncResource(call)
}
