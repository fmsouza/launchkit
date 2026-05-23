import { createContext, type ReactNode, useContext } from "react"
import type { IpcClient } from "@launchkit/ipc"

const IpcClientContext = createContext<IpcClient | null>(null)

export type IpcClientProviderProps = {
  readonly client: IpcClient
  readonly children: ReactNode
}

/** Injects the IPC client so pages/hooks consume it via `useIpcClient()`. */
export const IpcClientProvider = ({ client, children }: IpcClientProviderProps): JSX.Element => (
  <IpcClientContext.Provider value={client}>{children}</IpcClientContext.Provider>
)

/**
 * Read the injected `IpcClient`. Throws if no provider is mounted -- a missing
 * provider is a programmer error, not an expected runtime failure (so we throw
 * here rather than returning a `Result`).
 */
export const useIpcClient = (): IpcClient => {
  const client = useContext(IpcClientContext)
  if (client === null) {
    throw new Error("useIpcClient must be used within an IpcClientProvider")
  }
  return client
}
