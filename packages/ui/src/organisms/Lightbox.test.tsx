import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Lightbox } from "./Lightbox"

describe("Lightbox", () => {
  it("renders an image when kind=image and dataUrl set", () => {
    const { container } = render(
      <Lightbox
        open
        kind="image"
        title="p.png"
        dataUrl="data:image/png;base64,AAA"
        onClose={() => {}}
      />,
    )
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAA",
    )
  })

  it("renders a pre when kind=text and dataUrl set (base64-decoded)", () => {
    const text = Buffer.from("hello world").toString("base64")
    render(
      <Lightbox
        open
        kind="text"
        title="notes.txt"
        dataUrl={`data:text/plain;base64,${text}`}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId("lightbox-text").textContent).toContain(
      "hello world",
    )
  })

  it("renders nothing when open is false", () => {
    const { container } = render(
      <Lightbox
        open={false}
        kind="image"
        title="p.png"
        dataUrl="data:image/png;base64,AAA"
        onClose={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
