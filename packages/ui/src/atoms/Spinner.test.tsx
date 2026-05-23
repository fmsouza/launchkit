import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Spinner } from "./Spinner"

describe("Spinner", () => {
  it("renders a busy status region when given a label", () => {
    render(<Spinner label="Loading providers" />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })
  it("uses the label as the accessible name", () => {
    render(<Spinner label="Loading providers" />)
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading providers")
  })
})
