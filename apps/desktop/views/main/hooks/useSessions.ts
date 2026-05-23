import { useCallback } from "react"
import type { Session } from "@launchkit/types"
import type { IpcMethods } from "@launchkit/ipc"
import { useIpcClient } from "../IpcClientContext"
import { type AsyncResource, useAsyncResource } from "./useAsyncResource"

/** The optional `getSessions` filter, taken straight from the IPC contract. */
export type SessionsFilter = IpcMethods["getSessions"]["params"]

export const useSessions = (filter?: SessionsFilter): AsyncResource<readonly Session[]> => {
  const client = useIpcClient()
  // Serialize the filter so the callback identity (and thus the effect) only
  // changes when the filter's *value* changes, not on every render.
  const filterKey = filter === undefined ? "" : JSON.stringify(filter)
  const call = useCallback(
    () => client.getSessions(filterKey === "" ? undefined : (JSON.parse(filterKey) as SessionsFilter)),
    [client, filterKey],
  )
  return useAsyncResource(call)
}
