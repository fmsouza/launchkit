import { describe, it, expect } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { RoutingPage } from "./RoutingPage"
import type { ModelAlias } from "@launchkit/types"
import type { ProviderView } from "@launchkit/ipc"

const alias = { alias: "fast", providerId: "p_openai", providerModel: "gpt-4o-mini" } as unknown as ModelAlias
const view = {
  id: "p_openai", name: "OpenAI", sdkProvider: "openai",
  config: {}, secretFields: {}, models: ["gpt-4o-mini"],
} as unknown as ProviderView

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({
    getAliases: async () => ({ ok: true, value: [alias] }),
    getProviders: async () => ({ ok: true, value: [view] }),
    ...stubs,
  })
  render(<IpcClientProvider client={client}><RoutingPage /></IpcClientProvider>)
  return client
}

describe("RoutingPage", () => {
  it("renders each alias with its resolved provider name when loaded", async () => {
    renderPage({})
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument())
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
  })

  it("calls addAlias with the new mapping when the add form is submitted", async () => {
    const client = renderPage({ addAlias: async (p) => ({ ok: true, value: p }) })
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /add alias/i }))
    fireEvent.change(screen.getByLabelText("Alias name"), { target: { value: "smart" } })
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "p_openai" } })
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4o" } })
    fireEvent.click(screen.getByRole("button", { name: /save alias/i }))

    await waitFor(() => expect(client.calls.addAlias.length).toBe(1))
    expect(client.calls.addAlias[0]).toEqual({ alias: "smart", providerId: "p_openai", providerModel: "gpt-4o" })
  })

  it("calls deleteAlias with the alias name when a row is deleted", async () => {
    const client = renderPage({ deleteAlias: async () => ({ ok: true, value: null }) })
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    await waitFor(() => expect(client.calls.deleteAlias.length).toBe(1))
    expect(client.calls.deleteAlias[0]).toEqual({ alias: "fast" })
  })

  it("seeds the edit form and calls updateAlias when an existing alias is edited", async () => {
    const client = renderPage({ updateAlias: async () => ({ ok: true, value: alias }) })
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini")
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4o" } })
    fireEvent.click(screen.getByRole("button", { name: /save alias/i }))

    await waitFor(() => expect(client.calls.updateAlias.length).toBe(1))
    expect(client.calls.updateAlias[0]).toEqual({
      alias: "fast",
      input: { providerId: "p_openai", providerModel: "gpt-4o" },
    })
  })
})
