import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useProviders } from "./useProviders"
import type { ProviderView } from "@launchkit/ipc"

const view: ProviderView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
} as unknown as ProviderView

const Probe = (): JSX.Element => {
  const { data, loading, error, refetch } = useProviders()
  return (
    <div>
      <span>{loading ? "loading" : "idle"}</span>
      <span>{error === undefined ? "no-error" : error.kind}</span>
      <span>{data === undefined ? "no-data" : `count:${data.length}`}</span>
      <button type="button" onClick={() => refetch()}>refetch</button>
    </div>
  )
}

describe("useProviders", () => {
  it("starts loading then exposes the data when the call resolves Ok", async () => {
    const client = createFakeIpcClient({ getProviders: async () => ({ ok: true, value: [view] }) })
    render(<IpcClientProvider client={client}><Probe /></IpcClientProvider>)
    expect(screen.getByText("loading")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("count:1")).toBeInTheDocument())
    expect(screen.getByText("idle")).toBeInTheDocument()
    expect(screen.getByText("no-error")).toBeInTheDocument()
  })

  it("exposes the typed error and no data when the call resolves Err", async () => {
    const client = createFakeIpcClient({
      getProviders: async () => ({ ok: false, error: { kind: "transport-failed", detail: "down" } }),
    })
    render(<IpcClientProvider client={client}><Probe /></IpcClientProvider>)
    await waitFor(() => expect(screen.getByText("transport-failed")).toBeInTheDocument())
    expect(screen.getByText("no-data")).toBeInTheDocument()
  })

  it("re-invokes the client when refetch is called", async () => {
    const getProviders = mock(async () => ({ ok: true as const, value: [view] }))
    const client = createFakeIpcClient({ getProviders })
    render(<IpcClientProvider client={client}><Probe /></IpcClientProvider>)
    await waitFor(() => expect(screen.getByText("count:1")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "refetch" }))
    await waitFor(() => expect(getProviders).toHaveBeenCalledTimes(2))
  })
})
