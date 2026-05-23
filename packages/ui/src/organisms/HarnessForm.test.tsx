import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { HarnessForm } from "./HarnessForm"
import type { HarnessFormValues } from "./HarnessForm"

const initial: HarnessFormValues = {
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  defaultAlias: "default",
}

describe("HarnessForm", () => {
  it("seeds the fields from the initial values", () => {
    render(<HarnessForm initialValues={initial} onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText("Name")).toHaveValue("Claude Code")
    expect(screen.getByLabelText("Command")).toHaveValue("claude")
  })
  it("submits the edited values when the form is submitted", () => {
    const onSubmit = mock((_v: HarnessFormValues) => {})
    render(<HarnessForm initialValues={initial} onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "claude-next" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledWith({ ...initial, command: "claude-next" })
  })
  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = mock(() => {})
    render(<HarnessForm initialValues={initial} onSubmit={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it("does not submit when the command is empty", () => {
    const onSubmit = mock((_v: HarnessFormValues) => {})
    render(<HarnessForm initialValues={initial} onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
