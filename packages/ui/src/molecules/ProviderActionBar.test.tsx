import { describe, expect, it, mock } from "bun:test"
import type { ProviderAction } from "@spectrum/providers"
import { fireEvent, render, screen } from "@testing-library/react"
import { ProviderActionBar } from "./ProviderActionBar"

const actions: readonly ProviderAction[] = [
  { kind: "edit-config", id: "edit", label: "Edit provider", context: "both" },
  {
    kind: "set-secrets",
    id: "secrets",
    label: "Set secret",
    context: "provider",
  },
]

describe("ProviderActionBar", () => {
  it("renders a button per action when the context matches", () => {
    render(
      <ProviderActionBar
        actions={actions}
        context="provider"
        onAction={() => {}}
      />,
    )
    expect(
      screen.getByRole("button", { name: "Edit provider" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Set secret" }),
    ).toBeInTheDocument()
  })

  it("hides an action whose context excludes the current one", () => {
    render(
      <ProviderActionBar
        actions={actions}
        context="create"
        onAction={() => {}}
      />,
    )
    expect(screen.queryByRole("button", { name: "Set secret" })).toBeNull()
  })

  it("calls onAction with the action when its button is clicked", () => {
    const onAction = mock((_a: (typeof actions)[number]) => {})
    render(
      <ProviderActionBar
        actions={actions}
        context="provider"
        onAction={onAction}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit provider" }))
    expect(onAction).toHaveBeenCalledWith(actions[0])
  })

  it("renders nothing when no action matches the context", () => {
    const { container } = render(
      <ProviderActionBar actions={[]} context="provider" onAction={() => {}} />,
    )
    expect(container.textContent).toBe("")
  })
})
