import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { Button } from "./Button"

describe("Button", () => {
  it("renders its children as the accessible name", () => {
    render(<Button onClick={() => {}}>Launch</Button>)
    expect(screen.getByRole("button", { name: "Launch" })).toBeInTheDocument()
  })
  it("calls onClick when the button is clicked", () => {
    const onClick = mock(() => {})
    render(<Button onClick={onClick}>Go</Button>)
    fireEvent.click(screen.getByRole("button", { name: "Go" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it("does not call onClick when disabled and clicked", () => {
    const onClick = mock(() => {})
    render(<Button onClick={onClick} disabled>Go</Button>)
    fireEvent.click(screen.getByRole("button", { name: "Go" }))
    expect(onClick).not.toHaveBeenCalled()
  })
  it("applies the variant as a data attribute when a variant is given", () => {
    render(<Button onClick={() => {}} variant="danger">Delete</Button>)
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("data-variant", "danger")
  })
  it("defaults to the primary variant when none is given", () => {
    render(<Button onClick={() => {}}>Save</Button>)
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("data-variant", "primary")
  })
})
