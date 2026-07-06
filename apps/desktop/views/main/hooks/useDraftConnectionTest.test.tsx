import { describe, expect, it } from "bun:test"
import { act, render, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useDraftConnectionTest } from "./useDraftConnectionTest"

type ProbeHandle = {
  test: (input: {
    sdkProvider: "openai"
    config: Record<string, string>
    secrets: Record<string, string>
    providerModel: string
  }) => Promise<void>
  reset: () => void
}

const handles: ProbeHandle[] = []

const Probe = (): JSX.Element => {
  const hook = useDraftConnectionTest()
  handles.push({ test: hook.test, reset: hook.reset })
  return (
    <div>
      <span data-testid="testing">{hook.testing ? "testing" : "idle"}</span>
      <span data-testid="error">
        {hook.error === undefined ? "no-error" : hook.error.kind}
      </span>
      <span data-testid="result">
        {hook.result === undefined
          ? "no-result"
          : `ok:${hook.result.ok},latency:${hook.result.latencyMs}`}
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

describe("useDraftConnectionTest", () => {
  it("starts with no result, not testing, no error", async () => {
    const client = createFakeIpcClient({})
    renderProbe(client)
    await waitFor(() => expect(document.body).toHaveTextContent("idle"))
    expect(document.body).toHaveTextContent("no-result")
    expect(document.body).toHaveTextContent("no-error")
  })

  it("exposes result returned by testProviderDraft on success", async () => {
    const client = createFakeIpcClient({
      testProviderDraft: async () => ({
        ok: true,
        value: { ok: true, latencyMs: 12 },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.test({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "x" },
        providerModel: "gpt-4o",
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("ok:true,latency:12"),
    )
    expect(document.body).toHaveTextContent("idle")
    expect(document.body).toHaveTextContent("no-error")
    expect(client.calls.testProviderDraft[0]).toEqual({
      sdkProvider: "openai",
      config: {},
      secrets: { apiKey: "x" },
      providerModel: "gpt-4o",
    })
  })

  it("exposes an IpcError and no result when testProviderDraft returns an error", async () => {
    const client = createFakeIpcClient({
      testProviderDraft: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "connection refused" },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.test({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "bad" },
        providerModel: "gpt-4o",
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("handler-failed"),
    )
    expect(document.body).toHaveTextContent("no-result")
  })

  it("resets state back to initial after reset()", async () => {
    const client = createFakeIpcClient({
      testProviderDraft: async () => ({
        ok: true,
        value: { ok: true, latencyMs: 42 },
      }),
    })
    renderProbe(client)
    await waitFor(() => expect(handles.length).toBeGreaterThan(0))
    const handle = handles[handles.length - 1]
    if (handle === undefined) throw new Error("probe handle not captured")
    await act(async () => {
      await handle.test({
        sdkProvider: "openai",
        config: {},
        secrets: { apiKey: "x" },
        providerModel: "gpt-4o",
      })
    })
    await waitFor(() =>
      expect(document.body).toHaveTextContent("ok:true,latency:42"),
    )
    act(() => {
      handle.reset()
    })
    await waitFor(() => expect(document.body).toHaveTextContent("no-result"))
    expect(document.body).toHaveTextContent("no-error")
  })
})
