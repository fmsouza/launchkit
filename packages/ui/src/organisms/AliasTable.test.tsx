import { describe, it, expect, mock } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { AliasTable } from "./AliasTable"
import type { ModelAlias } from "@launchkit/types"

const aliases = [
  { alias: "fast", providerId: "p_openai", providerModel: "gpt-4o-mini" },
  { alias: "smart", providerId: "p_anthropic", providerModel: "claude-3-5-sonnet" },
] as unknown as readonly ModelAlias[]

const providerNames: Readonly<Record<string, string>> = {
  p_openai: "OpenAI",
  p_anthropic: "Anthropic",
}

describe("AliasTable", () => {
  it("renders a row for each alias with the resolved provider name", () => {
    render(<AliasTable aliases={aliases} providerNames={providerNames} onEdit={() => {}} onDelete={() => {}} />)
    expect(screen.getByText("fast")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("claude-3-5-sonnet")).toBeInTheDocument()
  })
  it("falls back to the provider id when no name is known", () => {
    render(<AliasTable aliases={aliases} providerNames={{}} onEdit={() => {}} onDelete={() => {}} />)
    expect(screen.getByText("p_openai")).toBeInTheDocument()
  })
  it("calls onEdit with the alias when a row's edit button is clicked", () => {
    const onEdit = mock((_a: string) => {})
    render(<AliasTable aliases={aliases} providerNames={providerNames} onEdit={onEdit} onDelete={() => {}} />)
    fireEvent.click(screen.getAllByRole("button", { name: /edit/i })[0] as HTMLElement)
    expect(onEdit).toHaveBeenCalledWith("fast")
  })
  it("shows an empty state when there are no aliases", () => {
    render(<AliasTable aliases={[]} providerNames={providerNames} onEdit={() => {}} onDelete={() => {}} />)
    expect(screen.getByRole("heading", { name: /no aliases/i })).toBeInTheDocument()
  })
})
