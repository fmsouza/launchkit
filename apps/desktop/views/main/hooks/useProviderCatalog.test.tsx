import { describe, expect, it } from "bun:test"
import type { ProviderCatalogEntry } from "@spectrum/providers"
import { render, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useProviderCatalog } from "./useProviderCatalog"

const fakeEntry: ProviderCatalogEntry = {
  key: "custom",
  label: "Custom (OpenAI-compatible)",
  configFields: [],
  secretFields: [],
  supportsCustomHeaders: true,
}

const Probe = (): JSX.Element => {
  const { data, loading, error } = useProviderCatalog()
  return (
    <div>
      <span>{loading ? "loading" : "idle"}</span>
      <span>{error === undefined ? "no-error" : error.kind}</span>
      <span>
        {data === undefined
          ? "no-data"
          : data.length === 0
            ? "empty"
            : `entries:${data.map((e) => e.key).join(",")}`}
      </span>
    </div>
  )
}

describe("useProviderCatalog", () => {
  it("calls getProviderCatalog and exposes entries on success", async () => {
    const client = createFakeIpcClient({
      getProviderCatalog: async () => ({
        ok: true,
        value: [fakeEntry],
      }),
    })
    render(
      <IpcClientProvider client={client}>
        <Probe />
      </IpcClientProvider>,
    )
    await waitFor(() =>
      expect(document.body).toHaveTextContent("entries:custom"),
    )
    expect(client.calls.getProviderCatalog).toHaveLength(1)
    expect(client.calls.getProviderCatalog[0]).toBeUndefined()
  })

  it("exposes an IpcError and no data when getProviderCatalog returns an error", async () => {
    const client = createFakeIpcClient({
      getProviderCatalog: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "catalog unavailable" },
      }),
    })
    render(
      <IpcClientProvider client={client}>
        <Probe />
      </IpcClientProvider>,
    )
    await waitFor(() =>
      expect(document.body).toHaveTextContent("handler-failed"),
    )
    expect(document.body).toHaveTextContent("no-data")
  })
})
