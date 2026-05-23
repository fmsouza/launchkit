import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { Select } from "./Select"

const options = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
]

describe("Select", () => {
  it("renders one option per provided option", () => {
    render(<Select value="openai" options={options} onChange={() => {}} />)
    expect(screen.getAllByRole("option")).toHaveLength(2)
  })
  it("reflects the selected value", () => {
    render(<Select value="anthropic" options={options} onChange={() => {}} />)
    expect(screen.getByRole("combobox")).toHaveValue("anthropic")
  })
  it("calls onChange with the chosen value when the selection changes", () => {
    const onChange = mock((_v: string) => {})
    render(<Select value="openai" options={options} onChange={onChange} />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "anthropic" } })
    expect(onChange).toHaveBeenCalledWith("anthropic")
  })
})
