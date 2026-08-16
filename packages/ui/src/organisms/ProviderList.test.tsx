import { describe, expect, it, mock } from "bun:test"
import type { ProviderAction } from "@spectrum/providers"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { ProviderList } from "./ProviderList"
import type { ProviderRow } from "./ProviderList"

const providers: readonly ProviderRow[] = [
  { id: "p_openai", name: "OpenAI", sdkProvider: "openai", secretSet: true },
  {
    id: "p_anthropic",
    name: "Anthropic",
    sdkProvider: "anthropic",
    secretSet: false,
  },
]

describe("ProviderList", () => {
  it("shows an empty state when there are no providers", () => {
    render(<ProviderList providers={[]} onAction={() => {}} />)
    expect(
      screen.getByRole("heading", { name: /no providers/i }),
    ).toBeInTheDocument()
  })

  it("renders a table with a row per provider", () => {
    const { container } = render(
      <ProviderList providers={providers} onAction={() => {}} />,
    )
    expect(container.querySelector("table")).not.toBeNull()
    const rows = container.querySelectorAll("tbody tr")
    expect(rows.length).toBe(2)
  })

  it("renders the provider name in each row", () => {
    render(<ProviderList providers={providers} onAction={() => {}} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
  })

  it("renders an info Badge with sdkProvider in each row", () => {
    const { container } = render(
      <ProviderList providers={providers} onAction={() => {}} />,
    )
    const infoBadges = Array.from(
      container.querySelectorAll("span[data-tone='info']"),
    )
    const texts = infoBadges.map((b) => b.textContent)
    expect(texts).toContain("openai")
    expect(texts).toContain("anthropic")
  })

  it("renders a 'Set' Badge (success) when secretSet is true", () => {
    const setProvider = providers[0] ?? {
      id: "",
      name: "",
      sdkProvider: "",
      secretSet: true,
    }
    const { container } = render(
      <ProviderList providers={[setProvider]} onAction={() => {}} />,
    )
    const badge = container.querySelector("span[data-tone='success']")
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe("Set")
  })

  it("renders a 'Not set' Badge (neutral) when secretSet is false", () => {
    const unsetProvider = providers[1] ?? {
      id: "",
      name: "",
      sdkProvider: "",
      secretSet: false,
    }
    const { container } = render(
      <ProviderList providers={[unsetProvider]} onAction={() => {}} />,
    )
    const badge = container.querySelector("span[data-tone='neutral']")
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe("Not set")
  })

  it("renders a 'Set secret' button in lk-cell-actions td per row", () => {
    const { container } = render(
      <ProviderList providers={providers} onAction={() => {}} />,
    )
    const rows = Array.from(container.querySelectorAll("tbody tr"))
    for (const row of rows) {
      const actionsCell = row.querySelector("td.lk-cell-actions")
      expect(actionsCell).not.toBeNull()
      const btn = within(actionsCell as HTMLElement).getByRole("button", {
        name: /set secret/i,
      })
      expect(btn).toBeInTheDocument()
    }
  })

  it("calls onAction with the provider id and the set-secrets action when 'Set secret' is clicked", () => {
    const onAction = mock((_id: string, _a: ProviderAction) => {})
    const { container } = render(
      <ProviderList providers={providers} onAction={onAction} />,
    )
    // Click the first row's Set secret button
    const firstRow = container.querySelector("tbody tr") as HTMLElement
    const btn = within(firstRow).getByRole("button", { name: /set secret/i })
    fireEvent.click(btn)
    expect(onAction).toHaveBeenCalledTimes(1)
    const [id, action] = onAction.mock.calls[0] as [string, ProviderAction]
    expect(id).toBe("p_openai")
    expect(action.kind).toBe("set-secrets")
  })

  it("does not render an article element or lk-list-row--card class", () => {
    const { container } = render(
      <ProviderList providers={providers} onAction={() => {}} />,
    )
    expect(container.querySelector("article")).toBeNull()
    expect(container.querySelector(".lk-list-row--card")).toBeNull()
  })

  it("renders an 'Edit' button in lk-cell-actions td per row", () => {
    const { container } = render(
      <ProviderList providers={providers} onAction={() => {}} />,
    )
    const rows = Array.from(container.querySelectorAll("tbody tr"))
    for (const row of rows) {
      const actionsCell = row.querySelector("td.lk-cell-actions")
      expect(actionsCell).not.toBeNull()
      const btn = within(actionsCell as HTMLElement).getByRole("button", {
        name: /^edit$/i,
      })
      expect(btn).toBeInTheDocument()
    }
  })

  it("calls onAction with the provider id and the edit-config action when 'Edit' is clicked", () => {
    const onAction = mock((_id: string, _a: ProviderAction) => {})
    const { container } = render(
      <ProviderList providers={providers} onAction={onAction} />,
    )
    const firstRow = container.querySelector("tbody tr") as HTMLElement
    const btn = within(firstRow).getByRole("button", { name: /^edit$/i })
    fireEvent.click(btn)
    expect(onAction).toHaveBeenCalledTimes(1)
    const [id, action] = onAction.mock.calls[0] as [string, ProviderAction]
    expect(id).toBe("p_openai")
    expect(action.kind).toBe("edit-config")
  })
})
