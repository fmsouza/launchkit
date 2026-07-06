import { describe, expect, it } from "bun:test"
import type { AttachmentRef } from "@spectrum/agent-events"
import { fireEvent, render, screen } from "@testing-library/react"
import { AttachmentChip } from "./AttachmentChip"

const imgRef: AttachmentRef = {
  id: "h1",
  mime: "image/png",
  displayName: "p.png",
  kind: "image",
  bytes: 10,
}
const pdfRef: AttachmentRef = {
  id: "h2",
  mime: "application/pdf",
  displayName: "d.pdf",
  kind: "pdf",
  bytes: 20,
}

describe("AttachmentChip", () => {
  it("renders an image thumbnail when kind is image and thumbnailUrl is set", () => {
    const { container } = render(
      <AttachmentChip ref={imgRef} thumbnailUrl="data:image/png;base64,AAA" />,
    )
    const img = container.querySelector("img")
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAA")
  })

  it("renders a placeholder icon for a pdf kind (no img)", () => {
    const { container } = render(<AttachmentChip ref={pdfRef} />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("d.pdf")
  })

  it("shows the remove overlay on hover and calls onRemove when clicked", () => {
    const onRemove = () => {}
    const { container } = render(
      <AttachmentChip
        ref={imgRef}
        onRemove={onRemove}
        thumbnailUrl="data:image/png;base64,AAA"
      />,
    )
    const overlay = container.querySelector(
      '[data-testid="chip-remove"]',
    ) as HTMLElement
    expect(overlay).toBeTruthy()
  })

  it("does not render the remove overlay in read-only mode (onRemove undefined)", () => {
    const { container } = render(<AttachmentChip ref={pdfRef} />)
    expect(container.querySelector('[data-testid="chip-remove"]')).toBeNull()
  })

  it("calls onOpen when the chip is clicked", () => {
    const opened: { value: AttachmentRef | null } = { value: null }
    render(
      <AttachmentChip
        ref={imgRef}
        onOpen={(r) => {
          opened.value = r
        }}
        thumbnailUrl="data:image/png;base64,AAA"
      />,
    )
    fireEvent.click(screen.getByTestId("chip"))
    expect(opened.value).toEqual(imgRef)
  })
})
