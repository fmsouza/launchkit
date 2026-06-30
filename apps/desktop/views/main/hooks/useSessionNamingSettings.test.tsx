import { describe, expect, it, mock } from "bun:test"
import { ok } from "@spectrum/utils"
import { act, renderHook, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { StoreProvider } from "../stores/createStores"
import { type FakeIpcClient, createFakeIpcClient } from "../test/fake-client"
import { createUpdateClient } from "../update/updateClient"
import { useSessionNamingSettings } from "./useSessionNamingSettings"

const renderWith = (client: FakeIpcClient) =>
  renderHook(() => useSessionNamingSettings(), {
    wrapper: ({ children }) => (
      <IpcClientProvider client={client}>
        <StoreProvider client={client} updateClient={createUpdateClient()}>
          {children}
        </StoreProvider>
      </IpcClientProvider>
    ),
  })

describe("useSessionNamingSettings", () => {
  it("loads the saved id on mount", async () => {
    const client = createFakeIpcClient({
      getSessionNamingSettings: async () => ok({ sessionNameModelId: "mdl_1" }),
    })
    const { result } = renderWith(client)
    await waitFor(() => expect(result.current.modelId).toBe("mdl_1"))
  })

  it("save persists a string id and updates local state", async () => {
    const saveMock = mock(async () => ok(null))
    const client = createFakeIpcClient({
      getSessionNamingSettings: async () => ok({ sessionNameModelId: null }),
      updateSessionNamingSettings: saveMock,
    })
    const { result } = renderWith(client)
    await waitFor(() => expect(result.current.modelId).toBeNull())
    await act(async () => {
      await result.current.save("mdl_2")
    })
    expect(saveMock).toHaveBeenCalledWith({ sessionNameModelId: "mdl_2" })
    expect(result.current.modelId).toBe("mdl_2")
  })

  it("save persists null (off)", async () => {
    const saveMock = mock(async () => ok(null))
    const client = createFakeIpcClient({
      getSessionNamingSettings: async () => ok({ sessionNameModelId: "mdl_1" }),
      updateSessionNamingSettings: saveMock,
    })
    const { result } = renderWith(client)
    await waitFor(() => expect(result.current.modelId).toBe("mdl_1"))
    await act(async () => {
      await result.current.save(null)
    })
    expect(saveMock).toHaveBeenCalledWith({ sessionNameModelId: null })
    expect(result.current.modelId).toBeNull()
  })
})
