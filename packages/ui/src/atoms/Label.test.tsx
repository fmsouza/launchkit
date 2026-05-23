import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Label } from "./Label"

describe("Label", () => {
  it("renders its children text", () => {
    render(<Label htmlFor="name">Provider name</Label>)
    expect(screen.getByText("Provider name")).toBeInTheDocument()
  })
  it("associates with the control via htmlFor", () => {
    render(
      <>
        <Label htmlFor="name">Provider name</Label>
        <input id="name" />
      </>,
    )
    expect(screen.getByLabelText("Provider name")).toBeInTheDocument()
  })
})
