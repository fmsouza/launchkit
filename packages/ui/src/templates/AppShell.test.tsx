import { describe, expect, it, mock } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { AppShell } from "./AppShell"

const baseProps = {
  mode: "sessions" as const,
  onModeChange: () => {},
  proxyRunning: true,
  master: <p>master pane</p>,
  detail: <p>detail pane</p>,
}

describe("AppShell", () => {
  it("renders the master and detail slots", () => {
    render(<AppShell {...baseProps} />)
    expect(screen.getByText("master pane")).toBeInTheDocument()
    expect(screen.getByText("detail pane")).toBeInTheDocument()
  })
  it("renders Sessions and Settings rail buttons", () => {
    render(<AppShell {...baseProps} />)
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument()
  })
  it("marks the Sessions rail button current when mode is sessions", () => {
    render(<AppShell {...baseProps} mode="sessions" />)
    expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    )
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).not.toHaveAttribute("aria-current")
  })
  it("calls onModeChange with settings when the Settings button is clicked", () => {
    const onModeChange = mock((_m: "sessions" | "settings") => {})
    render(<AppShell {...baseProps} onModeChange={onModeChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(onModeChange).toHaveBeenCalledWith("settings")
  })
  it("shows the proxy status as running when proxyRunning is true", () => {
    render(<AppShell {...baseProps} proxyRunning />)
    expect(screen.getByRole("img", { name: /proxy/i })).toHaveAttribute(
      "data-color",
      "green",
    )
  })
  it("shows the proxy status as stopped when proxyRunning is false", () => {
    render(<AppShell {...baseProps} proxyRunning={false} />)
    expect(screen.getByRole("img", { name: /proxy/i })).toHaveAttribute(
      "data-color",
      "grey",
    )
  })
  it("marks the shell root with the lk-shell hook", () => {
    const { container } = render(<AppShell {...baseProps} />)
    expect(container.querySelector(".lk-shell")).not.toBeNull()
  })
  it("renders SVG rail icons rather than text glyphs", () => {
    const { container } = render(<AppShell {...baseProps} />)
    // The primary rail renders exactly 3 SVGs: the brand mark + the two RailItem icons.
    expect(
      container.querySelectorAll("nav[aria-label='Primary'] svg").length,
    ).toBe(3)
  })

  it("renders the Spectrum brand mark in the primary rail", () => {
    const { getByRole } = render(<AppShell {...baseProps} />)
    expect(getByRole("img", { name: "Spectrum" })).toBeTruthy()
  })

  it("shows the proxy port in a tooltip when the rail status is hovered", () => {
    render(<AppShell {...baseProps} proxyRunning proxyPort={4000} />)
    fireEvent.mouseOver(screen.getByRole("img", { name: /proxy/i }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("4000")
  })
  it("shows a connection spinner above the proxy dot when activity is true", () => {
    render(<AppShell {...baseProps} activity />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })
  it("hides the connection spinner when activity is false", () => {
    render(<AppShell {...baseProps} activity={false} />)
    expect(screen.queryByRole("status")).toBeNull()
  })
})
