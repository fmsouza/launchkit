import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { EmptyState } from "./EmptyState"

describe("EmptyState", () => {
  it("renders the title as a heading", () => {
    render(<EmptyState title="No providers yet" hint="Add one to get started" />)
    expect(screen.getByRole("heading", { name: "No providers yet" })).toBeInTheDocument()
  })
  it("renders the hint text", () => {
    render(<EmptyState title="No providers yet" hint="Add one to get started" />)
    expect(screen.getByText("Add one to get started")).toBeInTheDocument()
  })
})
