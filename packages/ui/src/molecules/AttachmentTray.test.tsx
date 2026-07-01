import { describe, expect, it } from "bun:test"
import { render } from "@testing-library/react"
import { AttachmentTray } from "./AttachmentTray"

describe("AttachmentTray", () => {
  it("renders a chip per attachment", () => {
    const { container } = render(
      <AttachmentTray
        attachments={[
          {
            id: "h1",
            mime: "image/png",
            displayName: "a.png",
            kind: "image",
            bytes: 1,
          },
          {
            id: "h2",
            mime: "application/pdf",
            displayName: "b.pdf",
            kind: "pdf",
            bytes: 2,
          },
        ]}
      />,
    )
    expect(container.querySelectorAll(".lk-attachment-chip")).toHaveLength(2)
  })

  it("renders nothing when attachments is empty", () => {
    const { container } = render(<AttachmentTray attachments={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
