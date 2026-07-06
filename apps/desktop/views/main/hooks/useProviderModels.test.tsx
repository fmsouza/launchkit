import { describe, expect, it } from "bun:test"
import type { ProviderId } from "@spectrum/types"
import { render, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useProviderModels } from "./useProviderModels"

const Probe = ({
  providerId,
}: {
  readonly providerId: string
}): JSX.Element => {
  const { data, loading, error } = useProviderModels(providerId)
  return (
    <div>
      <span>{loading ? "loading" : "idle"}</span>
      <span>{error === undefined ? "no-error" : error.kind}</span>
      <span>
        {data === undefined
          ? "no-data"
          : data.length === 0
            ? "empty"
            : `models:${data.map((d) => d.id).join(",")}`}
      </span>
    </div>
  )
}

describe("useProviderModels", () => {
  it("returns empty data immediately without calling the client when providerId is empty", async () => {
    const client = createFakeIpcClient({})
    render(
      <IpcClientProvider client={client}>
        <Probe providerId="" />
      </IpcClientProvider>,
    )
    await waitFor(() => expect(document.body).toHaveTextContent("idle"))
    expect(client.calls.listProviderModels).toHaveLength(0)
    expect(document.body).toHaveTextContent("empty")
  })

  it("calls listProviderModels with the providerId and exposes the models on success", async () => {
    const client = createFakeIpcClient({
      listProviderModels: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
      }),
    })
    render(
      <IpcClientProvider client={client}>
        <Probe providerId="p_openai" />
      </IpcClientProvider>,
    )
    await waitFor(() =>
      expect(document.body).toHaveTextContent("models:gpt-4o,gpt-4o-mini"),
    )
    expect(client.calls.listProviderModels[0]).toEqual({
      providerId: "p_openai" as ProviderId,
    })
  })

  it("exposes an IpcError and no data when listProviderModels returns an error", async () => {
    const client = createFakeIpcClient({
      listProviderModels: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "unsupported" },
      }),
    })
    render(
      <IpcClientProvider client={client}>
        <Probe providerId="p_anthropic" />
      </IpcClientProvider>,
    )
    await waitFor(() =>
      expect(document.body).toHaveTextContent("handler-failed"),
    )
    expect(document.body).toHaveTextContent("no-data")
  })

  it("returns models sorted alphabetically even when the provider returns them unsorted", async () => {
    const client = createFakeIpcClient({
      listProviderModels: async () => ({
        ok: true,
        value: {
          models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }, { id: "gpt-3.5" }],
        },
      }),
    })
    render(
      <IpcClientProvider client={client}>
        <Probe providerId="p_openai" />
      </IpcClientProvider>,
    )
    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "models:gpt-3.5,gpt-4o,gpt-4o-mini",
      ),
    )
  })
})
