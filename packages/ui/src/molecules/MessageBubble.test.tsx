import { describe, expect, it } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MessageBubble } from "./MessageBubble"

describe("MessageBubble", () => {
  it("renders the message text", () => {
    render(<MessageBubble text="Hello there" />)
    expect(screen.getByText("Hello there")).toBeInTheDocument()
    cleanup()
  })

  it("renders Markdown (bold + inline code) as real elements", () => {
    render(<MessageBubble text="this is **bold** and `code`" />)
    expect(screen.getByText("bold").tagName).toBe("STRONG")
    expect(screen.getByText("code").tagName).toBe("CODE")
    cleanup()
  })

  it("defaults to the assistant role", () => {
    const { container } = render(<MessageBubble text="hi" />)
    expect(container.querySelector(".lk-message-bubble")).toHaveAttribute(
      "data-role",
      "assistant",
    )
    cleanup()
  })

  it("marks a user message with data-role=user (for right alignment)", () => {
    const { container } = render(<MessageBubble text="hi" author="user" />)
    expect(container.querySelector(".lk-message-bubble")).toHaveAttribute(
      "data-role",
      "user",
    )
    cleanup()
  })

  it("marks an error-toned message with data-tone=error and an alert role", () => {
    const { container } = render(
      <MessageBubble text="API Error: 429 rate limited" tone="error" />,
    )
    const bubble = container.querySelector(".lk-message-bubble")
    expect(bubble).toHaveAttribute("data-tone", "error")
    expect(bubble).toHaveAttribute("role", "alert")
    cleanup()
  })

  it("carries no tone attribute or alert role by default", () => {
    const { container } = render(<MessageBubble text="hi" />)
    const bubble = container.querySelector(".lk-message-bubble")
    expect(bubble).not.toHaveAttribute("data-tone")
    expect(bubble).not.toHaveAttribute("role")
    cleanup()
  })

  it("calls onOpenLink with the href when a link is clicked and onOpenLink is provided", () => {
    let opened: string | undefined
    render(
      <MessageBubble
        text="[a link](https://example.com)"
        onOpenLink={(url) => {
          opened = url
        }}
      />,
    )
    fireEvent.click(screen.getByRole("link", { name: "a link" }))
    expect(opened).toBe("https://example.com")
    cleanup()
  })

  it("renders a real href on the link so the native nav-lock can route it to the OS browser", () => {
    render(
      <MessageBubble
        text="[a link](https://example.com)"
        onOpenLink={() => {}}
      />,
    )
    // The <a> keeps its href (so right-click "Open Link" / copy-link work and the
    // will-navigate nav-lock has a URL to route). The onClick calls preventDefault
    // (verified by the onOpenLink test above, which only fires because the React
    // onClick runs) so the webview never navigates in-window.
    const a = screen.getByRole("link", { name: "a link" })
    expect(a.getAttribute("href")).toBe("https://example.com")
    cleanup()
  })

  it("renders links but does not call onOpenLink when it is not provided", () => {
    let opened: string | undefined
    render(<MessageBubble text="[a link](https://example.com)" />)
    fireEvent.click(screen.getByRole("link", { name: "a link" }))
    expect(opened).toBeUndefined()
    cleanup()
  })
})

describe("MessageBubble failed state", () => {
  it("renders Resend and Cancel when failed and fires the callbacks", () => {
    let resent = 0
    let cancelled = 0
    render(
      <MessageBubble
        text="hi"
        author="user"
        status="failed"
        onResend={() => {
          resent += 1
        }}
        onCancel={() => {
          cancelled += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Resend" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(resent).toBe(1)
    expect(cancelled).toBe(1)
  })

  it("shows a sending state without action buttons", () => {
    const { container } = render(
      <MessageBubble text="hi" author="user" status="sending" />,
    )
    expect(container.querySelector('[data-status="sending"]')).not.toBeNull()
    expect(screen.queryByRole("button", { name: "Resend" })).toBeNull()
  })
})
