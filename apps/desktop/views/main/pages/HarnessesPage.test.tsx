import { describe, expect, it } from "bun:test"
import type { HarnessView } from "@spectrum/ipc"
import type { HarnessDefinition, HarnessId } from "@spectrum/types"
import { screen, waitFor } from "@testing-library/react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { HarnessesPage } from "./HarnessesPage"

const claude = {
  id: "claude" as HarnessId,
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: { ANTHROPIC_BASE_URL: "{{proxyUrl}}" },
  builtIn: true,
  native: true,
} as unknown as HarnessDefinition
const codex = {
  id: "codex" as HarnessId,
  name: "Codex",
  command: "codex",
  apiFormat: "openai",
  envTemplate: { OPENAI_BASE_URL: "{{proxyUrl}}" },
  builtIn: true,
  native: true,
} as unknown as HarnessDefinition

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({
    getHarnesses: async () => ({
      ok: true as const,
      value: [claude, codex] as unknown as HarnessView[],
    }),
    ...stubs,
  })
  renderWithProviders(<HarnessesPage />, client)
  return client
}

describe("HarnessesPage", () => {
  it("renders the built-in list with lk-list/lk-list-row/lk-list-row__label hooks", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("Claude Code")).toBeInTheDocument(),
    )
    const lists = document.querySelectorAll("ul.lk-list")
    expect(lists.length).toBe(1)
    const rows = document.querySelectorAll("li.lk-list-row")
    expect(rows.length).toBe(2)
    const labels = document.querySelectorAll(".lk-list-row__label")
    expect(labels.length).toBe(2)
  })

  it("lists the built-in harnesses under a single Built-in section when loaded", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("Claude Code")).toBeInTheDocument(),
    )
    expect(
      screen.getByRole("heading", { name: /built-in/i }),
    ).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
  })

  it("does not offer an Add custom harness control (custom harnesses are unsupported)", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("Claude Code")).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole("button", { name: /add custom harness/i }),
    ).toBeNull()
  })

  it("does not offer a delete control for a built-in harness", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("Claude Code")).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole("button", { name: "Delete Claude Code" }),
    ).toBeNull()
  })
})
