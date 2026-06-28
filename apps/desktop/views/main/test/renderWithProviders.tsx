import type { IpcClient } from "@spectrum/ipc"
import { type RenderResult, render } from "@testing-library/react"
import type { ReactElement } from "react"
import { IpcClientProvider } from "../IpcClientContext"
import { StoreProvider } from "../stores/createStores"
import { createUpdateClient } from "../update/updateClient"

/** Render UI wrapped in BOTH the IPC client and the store providers. */
export const renderWithProviders = (
  ui: ReactElement,
  client: IpcClient,
  initialView = "sessions",
): RenderResult =>
  render(
    <IpcClientProvider client={client}>
      <StoreProvider
        client={client}
        initialView={initialView}
        updateClient={createUpdateClient()}
      >
        {ui}
      </StoreProvider>
    </IpcClientProvider>,
  )
