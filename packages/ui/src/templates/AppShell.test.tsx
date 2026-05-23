import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { AppShell } from "./AppShell"

const items = [
  { route: "dashboard", label: "Dashboard" },
  { route: "providers", label: "Providers" },
]

describe("AppShell", () => {
  it("renders a nav item per route", () => {
    render(
      <AppShell navItems={items} activeRoute="dashboard" onNavigate={() => {}}>
        <p>content</p>
      </AppShell>,
    )
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Providers" })).toBeInTheDocument()
  })
  it("marks the active route as current", () => {
    render(
      <AppShell navItems={items} activeRoute="providers" onNavigate={() => {}}>
        <p>content</p>
      </AppShell>,
    )
    expect(screen.getByRole("link", { name: "Providers" })).toHaveAttribute("aria-current", "page")
  })
  it("renders the content slot", () => {
    render(
      <AppShell navItems={items} activeRoute="dashboard" onNavigate={() => {}}>
        <p>hello content</p>
      </AppShell>,
    )
    expect(screen.getByText("hello content")).toBeInTheDocument()
  })
  it("calls onNavigate with the route when a nav item is clicked", () => {
    const onNavigate = mock((_r: string) => {})
    render(
      <AppShell navItems={items} activeRoute="dashboard" onNavigate={onNavigate}>
        <p>content</p>
      </AppShell>,
    )
    fireEvent.click(screen.getByRole("link", { name: "Providers" }))
    expect(onNavigate).toHaveBeenCalledWith("providers")
  })
})
