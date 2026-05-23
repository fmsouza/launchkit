import { describe, it, expect } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { ProvidersPage } from "./ProvidersPage"
import type { ProviderView } from "@launchkit/ipc"

const view: ProviderView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
} as unknown as ProviderView

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({ getProviders: async () => ({ ok: true, value: [view] }), ...stubs })
  render(<IpcClientProvider client={client}><ProvidersPage /></IpcClientProvider>)
  return client
}

describe("ProvidersPage", () => {
  it("renders the provider name once the providers load", async () => {
    renderPage({})
    await waitFor(() => expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument())
  })

  it("shows the secret field as set without rendering any secret value", async () => {
    renderPage({})
    await waitFor(() => expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument())
    // Presence flag is shown...
    expect(screen.getByText(/apiKey/i)).toBeInTheDocument()
    expect(screen.getByText("apiKey: set")).toBeInTheDocument()
    // ...and no secret value is anywhere in the DOM (the view never carries one).
    expect(document.body.textContent).not.toContain("sk-")
  })

  it("calls setProviderSecret with the typed value when the secret form is submitted", async () => {
    const client = renderPage({ setProviderSecret: async () => ({ ok: true, value: null }) })
    await waitFor(() => expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Set secret for OpenAI" }))
    fireEvent.change(screen.getByLabelText("Secret field"), { target: { value: "apiKey" } })
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "sk-secret-123" } })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))

    await waitFor(() => expect(client.calls.setProviderSecret.length).toBe(1))
    expect(client.calls.setProviderSecret[0]).toEqual({
      providerId: "p_openai",
      field: "apiKey",
      value: "sk-secret-123",
    })
  })

  it("never re-displays the secret value after submitting it", async () => {
    const client = renderPage({ setProviderSecret: async () => ({ ok: true, value: null }) })
    await waitFor(() => expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Set secret for OpenAI" }))
    fireEvent.change(screen.getByLabelText("Secret field"), { target: { value: "apiKey" } })
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "sk-secret-123" } })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))

    await waitFor(() => expect(client.calls.setProviderSecret.length).toBe(1))
    // The write-only form clears and the value is not echoed anywhere.
    expect(screen.queryByDisplayValue("sk-secret-123")).toBeNull()
  })

  it("submits the add-provider form with non-secret config and secret field names only", async () => {
    const client = renderPage({
      addProvider: async () => ({ ok: true, value: view }),
    })
    await waitFor(() => expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Groq" } })
    fireEvent.change(screen.getByLabelText("SDK provider"), { target: { value: "groq" } })
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }))

    await waitFor(() => expect(client.calls.addProvider.length).toBe(1))
    const params = client.calls.addProvider[0]
    expect(params).toMatchObject({ name: "Groq", sdkProvider: "groq" })
    // No raw secret ever travels with an add.
    expect(params).not.toHaveProperty("secrets")
  })
})
