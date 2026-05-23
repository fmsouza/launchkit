import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderList } from "./ProviderList"
import type { ProviderDisplay } from "../molecules/ProviderCard"

const providers: readonly ProviderDisplay[] = [
  { id: "p_openai", name: "OpenAI", sdkProvider: "openai" },
  { id: "p_anthropic", name: "Anthropic", sdkProvider: "anthropic" },
]

describe("ProviderList", () => {
  it("renders one card per provider", () => {
    render(<ProviderList providers={providers} onAdd={() => {}} onSelect={() => {}} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
  })
  it("shows an empty state when there are no providers", () => {
    render(<ProviderList providers={[]} onAdd={() => {}} onSelect={() => {}} />)
    expect(screen.getByRole("heading", { name: /no providers/i })).toBeInTheDocument()
  })
  it("calls onAdd when the add button is clicked", () => {
    const onAdd = mock(() => {})
    render(<ProviderList providers={providers} onAdd={onAdd} onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
  it("calls onSelect with the provider id when a provider is selected", () => {
    const onSelect = mock((_id: string) => {})
    render(<ProviderList providers={providers} onAdd={() => {}} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Select OpenAI" }))
    expect(onSelect).toHaveBeenCalledWith("p_openai")
  })
})
