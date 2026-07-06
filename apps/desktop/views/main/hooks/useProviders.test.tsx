import { describe, expect, it, mock } from "bun:test"
import type { ProviderView } from "@spectrum/ipc"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { useProviders } from "./useProviders"

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
      <button type="button" onClick={() => refetch()}>
        refetch
      </button>
    </div>
  )
}

describe("useProviders", () => {
  it("starts loading then exposes the data when the call resolves Ok", async () => {
    const client = createFakeIpcClient({
      getProviders: async () => ({ ok: true, value: [view] }),
    })
    renderWithProviders(<Probe />, client)
    expect(screen.getByText("loading")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("count:1")).toBeInTheDocument())
    expect(screen.getByText("idle")).toBeInTheDocument()
    expect(screen.getByText("no-error")).toBeInTheDocument()
  })

  it("exposes the typed error and no data when the call resolves Err", async () => {
    const client = createFakeIpcClient({
      getProviders: async () => ({
        ok: false,
        error: { kind: "transport-failed", detail: "down" },
      }),
    })
    renderWithProviders(<Probe />, client)
    await waitFor(() =>
      expect(screen.getByText("transport-failed")).toBeInTheDocument(),
    )
    expect(screen.getByText("no-data")).toBeInTheDocument()
  })

  it("re-invokes the client when refetch is called", async () => {
    const getProviders = mock(async () => ({
      ok: true as const,
      value: [view],
    }))
    const client = createFakeIpcClient({ getProviders })
    renderWithProviders(<Probe />, client)
    await waitFor(() => expect(screen.getByText("count:1")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "refetch" }))
    await waitFor(() => expect(getProviders).toHaveBeenCalledTimes(2))
  })
})
