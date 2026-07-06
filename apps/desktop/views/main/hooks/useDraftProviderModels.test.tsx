import { describe, expect, it } from "bun:test"
import type { DiscoveredModel } from "@spectrum/types"
import { act, render, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useDraftProviderModels } from "./useDraftProviderModels"

type ProbeHandle = {
  discover: (input: {
    sdkProvider: "openai"
    config: Record<string, string>
    secrets: Record<string, string>
  }) => Promise<readonly DiscoveredModel[]>
  reset: () => void
}

const handles: ProbeHandle[] = []

const Probe = (): JSX.Element => {
  const hook = useDraftProviderModels()
  handles.push({ discover: hook.discover, reset: hook.reset })
  return (
    <div>
      <span data-testid="loading">{hook.loading ? "loading" : "idle"}</span>
      <span data-testid="error">
        {hook.error === undefined ? "no-error" : hook.error.kind}
      </span>
      <span data-testid="models">
        {hook.models.length === 0
          ? "empty"
          : `models:${hook.models.map((m) => m.id).join(",")}`}
      </span>
    </div>
  )
}

const renderProbe = (client: ReturnType<typeof createFakeIpcClient>) => {
  handles.length = 0
  return render(
    <IpcClientProvider client={client}>
      <Probe />
    </IpcClientProvider>,
  )
}

describe("useDraftProviderModels", () => {
  it("starts with empty models, not loading, no error", async () => {
    const client = createFakeIpcClient({})
    renderProbe(client)
    await waitFor(() => expect(document.body).toHaveTextContent("idle"))
    expect(document.body).toHaveTextContent("empty")
    expect(document.body).toHaveTextContent("no-error")
  })

  it("exposes models returned by listProviderModelsDraft on success", async () => {
    const client = createFakeIpcClient({
      listProviderModelsDraft: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }] },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.discover({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "x" },
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("models:gpt-4o"),
    )
    expect(document.body).toHaveTextContent("idle")
    expect(document.body).toHaveTextContent("no-error")
    expect(client.calls.listProviderModelsDraft[0]).toEqual({
      sdkProvider: "openai",
      config: {},
      secrets: { apiKey: "x" },
    })
  })

  it("exposes an IpcError and clears models when listProviderModelsDraft returns an error", async () => {
    const client = createFakeIpcClient({
      listProviderModelsDraft: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "auth error" },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.discover({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "bad" },
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("handler-failed"),
    )
    expect(document.body).toHaveTextContent("empty")
  })

  it("returns the discovered models from discover() on success", async () => {
    const client = createFakeIpcClient({
      listProviderModelsDraft: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }] },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    let returned: readonly { id: string }[] = []
    await act(async () => {
      returned = await handle.discover({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "x" },
      })
    })
    expect(returned).toEqual([{ id: "gpt-4o" }])
  })

  it("returns [] from discover() when listProviderModelsDraft returns an error", async () => {
    const client = createFakeIpcClient({
      listProviderModelsDraft: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "auth error" },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    let returned: readonly { id: string }[] = [{ id: "non-empty" }]
    await act(async () => {
      returned = await handle.discover({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "bad" },
      })
    })
    expect(returned).toEqual([])
  })

  it("resets state back to initial after reset()", async () => {
    const client = createFakeIpcClient({
      listProviderModelsDraft: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }] },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.discover({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "x" },
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("models:gpt-4o"),
    )
    act(() => {
      handle.reset()
    })
    await waitFor(() => expect(document.body).toHaveTextContent("empty"))
    expect(document.body).toHaveTextContent("no-error")
  })
})
