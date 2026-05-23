import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { TextInput } from "./TextInput"

describe("TextInput", () => {
  it("renders the current value as a textbox", () => {
    render(<TextInput value="hello" onChange={() => {}} />)
    expect(screen.getByRole("textbox")).toHaveValue("hello")
  })
  it("shows the placeholder when given one", () => {
    render(<TextInput value="" onChange={() => {}} placeholder="API base URL" />)
    expect(screen.getByPlaceholderText("API base URL")).toBeInTheDocument()
  })
  it("calls onChange with the new text when the user types", () => {
    const onChange = mock((_v: string) => {})
    render(<TextInput value="" onChange={onChange} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } })
    expect(onChange).toHaveBeenCalledWith("abc")
  })
  it("renders a password field when type is password", () => {
    const { container } = render(<TextInput value="" onChange={() => {}} type="password" />)
    expect(container.querySelector("input[type='password']")).not.toBeNull()
  })
})
