import { describe, it, expect } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { SessionsPage } from "./SessionsPage"
import type { Session, HarnessDefinition } from "@launchkit/types"

const makeSession = (n: number): Session =>
  ({ id: `s_${n}`, harnessId: "claude", alias: "default", startedAt: `2026-05-23T10:00:${String(n).padStart(2, "0")}.000Z` } as unknown as Session)

const manySessions: readonly Session[] = Array.from({ length: 60 }, (_, i) => makeSession(i))
const harness = {
  id: "claude", name: "Claude Code", command: "claude", apiFormat: "anthropic",
  envTemplate: {}, defaultAlias: "default", builtIn: true,
} as unknown as HarnessDefinition

const renderPage = (sessions: readonly Session[], stubs: Parameters<typeof createFakeIpcClient>[0] = {}) => {
  const client = createFakeIpcClient({
    getSessions: async () => ({ ok: true, value: sessions }),
    getHarnesses: async () => ({ ok: true, value: [harness] }),
    ...stubs,
  })
  render(<IpcClientProvider client={client}><SessionsPage /></IpcClientProvider>)
  return client
}

describe("SessionsPage", () => {
  it("renders only the capped number of rows for a long history", async () => {
    renderPage(manySessions)
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1))
    // 1 header + a bounded page window (50), not all 60.
    expect(screen.getAllByRole("row")).toHaveLength(51)
    expect(screen.getByText("+10 more")).toBeInTheDocument()
  })

  it("raises the cap and renders more rows when show more is clicked", async () => {
    renderPage(manySessions)
    await waitFor(() => expect(screen.getByText("+10 more")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /show more/i }))
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(61))
  })

  it("refetches sessions filtered by harness when a harness filter is chosen", async () => {
    const client = renderPage(manySessions)
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1))
    fireEvent.change(screen.getByLabelText("Filter by harness"), { target: { value: "claude" } })
    await waitFor(() =>
      expect(client.calls.getSessions.some((c) => c?.harnessId === "claude")).toBe(true),
    )
  })

  it("shows an empty state when there are no sessions", async () => {
    renderPage([])
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /no sessions/i })).toBeInTheDocument(),
    )
  })
})
