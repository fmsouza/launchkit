import { describe, expect, it, mock } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { ModelRow } from "./ModelRow"

const props = {
  id: "mdl_fast",
  provider: "OpenAI",
  model: "gpt-4o-mini",
  aliases: "",
  capabilities: "",
}

describe("ModelRow", () => {
  it("wraps row actions in a wrapping cell hook", () => {
    const { container } = render(
      <table>
        <tbody>
          <ModelRow {...props} onEdit={() => {}} onDelete={() => {}} />
        </tbody>
      </table>,
    )
    expect(container.querySelector("td.lk-cell-actions")).not.toBeNull()
  })
  it("renders the provider and model", () => {
    render(
      <table>
        <tbody>
          <ModelRow {...props} onEdit={() => {}} onDelete={() => {}} />
        </tbody>
      </table>,
    )
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
  })
  it("calls onEdit with the id when the edit button is clicked", () => {
    const onEdit = mock((_a: string) => {})
    render(
      <table>
        <tbody>
          <ModelRow {...props} onEdit={onEdit} onDelete={() => {}} />
        </tbody>
      </table>,
    )
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    expect(onEdit).toHaveBeenCalledWith("mdl_fast")
  })
  it("calls onDelete with the id when the delete button is clicked", () => {
    const onDelete = mock((_a: string) => {})
    render(
      <table>
        <tbody>
          <ModelRow {...props} onEdit={() => {}} onDelete={onDelete} />
        </tbody>
      </table>,
    )
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(onDelete).toHaveBeenCalledWith("mdl_fast")
  })
  it("renders the aliases string in a cell when provided", () => {
    render(
      <table>
        <tbody>
          <ModelRow
            {...props}
            aliases="haiku, small"
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </tbody>
      </table>,
    )
    expect(screen.getByText("haiku, small")).toBeInTheDocument()
  })
  it("renders an empty aliases cell when aliases is empty", () => {
    const { container } = render(
      <table>
        <tbody>
          <ModelRow
            {...props}
            aliases=""
            capabilities=""
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </tbody>
      </table>,
    )
    const cells = container.querySelectorAll("td")
    // provider, model, aliases, capabilities, actions = 5 cells
    expect(cells.length).toBe(5)
  })

  it("renders the capabilities cell", () => {
    render(
      <table>
        <tbody>
          <ModelRow
            {...props}
            capabilities="images"
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </tbody>
      </table>,
    )
    expect(screen.getByText("images")).toBeInTheDocument()
  })
})
