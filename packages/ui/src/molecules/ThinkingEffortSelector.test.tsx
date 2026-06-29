import { describe, expect, it, mock } from "bun:test"
import { fireEvent, render } from "@testing-library/react"
import { ThinkingEffortSelector } from "./ThinkingEffortSelector"

describe("ThinkingEffortSelector", () => {
  it("shows the current tier and lists all six by default", () => {
    const { getByRole, getAllByRole } = render(
      <ThinkingEffortSelector effort="medium" onChange={() => {}} />,
    )
    fireEvent.click(getByRole("button"))
    expect(getAllByRole("menuitemradio")).toHaveLength(6)
  })
  it("emits the chosen tier", () => {
    const onChange = mock(() => {})
    const { getByRole, getByText } = render(
      <ThinkingEffortSelector effort="medium" onChange={onChange} />,
    )
    fireEvent.click(getByRole("button"))
    fireEvent.click(getByText("High"))
    expect(onChange).toHaveBeenCalledWith("high")
  })
})
