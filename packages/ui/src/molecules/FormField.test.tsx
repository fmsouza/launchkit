import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { FormField } from "./FormField"
import { TextInput } from "../atoms/TextInput"

describe("FormField", () => {
  it("labels the wrapped control via the shared id", () => {
    render(
      <FormField id="base-url" label="Base URL">
        <TextInput id="base-url" value="" onChange={() => {}} />
      </FormField>,
    )
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument()
  })
  it("shows the error message when an error is provided", () => {
    render(
      <FormField id="base-url" label="Base URL" error="Required">
        <TextInput id="base-url" value="" onChange={() => {}} />
      </FormField>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Required")
  })
  it("renders no alert when there is no error", () => {
    render(
      <FormField id="base-url" label="Base URL">
        <TextInput id="base-url" value="" onChange={() => {}} />
      </FormField>,
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
