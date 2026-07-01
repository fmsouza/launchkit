import { describe, expect, it } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { Icon } from "./Icon"

describe("Icon", () => {
  it("renders an svg at the given size", () => {
    const { container } = render(<Icon name="sessions" size={22} />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute("width", "22")
    expect(svg).toHaveAttribute("height", "22")
  })

  it("defaults to size 20 when no size is given", () => {
    const { container } = render(<Icon name="sessions" />)
    expect(container.querySelector("svg")).toHaveAttribute("width", "20")
  })

  it("is aria-hidden when no title is given", () => {
    const { container } = render(<Icon name="settings" />)
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    )
  })

  it("is a labelled img when a title is given", () => {
    render(<Icon name="settings" title="Settings" />)
    expect(screen.getByRole("img", { name: "Settings" })).toBeInTheDocument()
  })

  it("renders each of the new glyph names", () => {
    for (const name of [
      "send",
      "stop",
      "chevron-down",
      "shield",
      "pencil",
      "list",
      "zap",
    ] as const) {
      render(<Icon name={name} title={name} />)
      expect(screen.getByRole("img", { name })).toBeInTheDocument()
      cleanup()
    }
  })

  it("renders the paperclip glyph without crashing", () => {
    const { container } = render(<Icon name="paperclip" />)
    expect(container.querySelector("svg")).toBeTruthy()
  })

  it("renders the x glyph", () => {
    const { container } = render(<Icon name="x" />)
    expect(container.querySelector("svg")).toBeTruthy()
  })
})
