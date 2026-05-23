import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Badge } from "./Badge"

describe("Badge", () => {
  it("renders its children text", () => {
    render(<Badge tone="info">anthropic</Badge>)
    expect(screen.getByText("anthropic")).toBeInTheDocument()
  })
  it("applies the tone as a data attribute", () => {
    render(<Badge tone="success">built-in</Badge>)
    expect(screen.getByText("built-in")).toHaveAttribute("data-tone", "success")
  })
})
