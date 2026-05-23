import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderCard } from "./ProviderCard"
import type { ProviderDisplay } from "./ProviderCard"

const provider: ProviderDisplay = { id: "p_openai", name: "OpenAI", sdkProvider: "openai" }

describe("ProviderCard", () => {
  it("renders the provider name", () => {
    render(<ProviderCard provider={provider} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })
  it("renders the sdk provider as a badge", () => {
    render(<ProviderCard provider={provider} />)
    expect(screen.getByText("openai")).toHaveAttribute("data-tone")
  })
  it("calls onLaunch with the provider id when the launch button is clicked", () => {
    const onLaunch = mock((_id: string) => {})
    render(<ProviderCard provider={provider} onLaunch={onLaunch} />)
    fireEvent.click(screen.getByRole("button", { name: /launch/i }))
    expect(onLaunch).toHaveBeenCalledWith("p_openai")
  })
  it("renders no launch button when onLaunch is not provided", () => {
    render(<ProviderCard provider={provider} />)
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull()
  })
})
