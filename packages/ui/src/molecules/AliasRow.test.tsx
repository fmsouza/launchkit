import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { AliasRow } from "./AliasRow"

const props = { alias: "fast", provider: "OpenAI", model: "gpt-4o-mini" }

describe("AliasRow", () => {
  it("renders the alias, provider, and model", () => {
    render(
      <table><tbody>
        <AliasRow {...props} onEdit={() => {}} onDelete={() => {}} />
      </tbody></table>,
    )
    expect(screen.getByText("fast")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
  })
  it("calls onEdit with the alias when the edit button is clicked", () => {
    const onEdit = mock((_a: string) => {})
    render(
      <table><tbody>
        <AliasRow {...props} onEdit={onEdit} onDelete={() => {}} />
      </tbody></table>,
    )
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    expect(onEdit).toHaveBeenCalledWith("fast")
  })
  it("calls onDelete with the alias when the delete button is clicked", () => {
    const onDelete = mock((_a: string) => {})
    render(
      <table><tbody>
        <AliasRow {...props} onEdit={() => {}} onDelete={onDelete} />
      </tbody></table>,
    )
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(onDelete).toHaveBeenCalledWith("fast")
  })
})
