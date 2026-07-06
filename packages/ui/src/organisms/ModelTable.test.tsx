import { describe, expect, it, mock } from "bun:test"
import type { ModelRoute } from "@spectrum/types"
import { fireEvent, render, screen } from "@testing-library/react"
import { ModelTable } from "./ModelTable"

const models = [
  {
    id: "mdl_fast",
    providerId: "p_openai",
    providerModel: "gpt-4o-mini",
    aliases: ["haiku", "small"],
    attachments: {},
  },
  {
    id: "mdl_smart",
    providerId: "p_anthropic",
    providerModel: "claude-3-5-sonnet",
    aliases: [],
    attachments: { image: true, pdf: true },
  },
] as unknown as readonly ModelRoute[]

const providerNames: Readonly<Record<string, string>> = {
  p_openai: "OpenAI",
  p_anthropic: "Anthropic",
}

describe("ModelTable", () => {
  it("renders Provider/Model/Aliases/Actions column headers", () => {
    render(
      <ModelTable
        models={models}
        providerNames={providerNames}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(
      screen.getByRole("columnheader", { name: "Provider" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("columnheader", { name: "Model" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("columnheader", { name: "Aliases" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("columnheader", { name: "Actions" }),
    ).toBeInTheDocument()
  })

  it("formats attachment capabilities per row", () => {
    render(
      <ModelTable
        models={
          [
            {
              id: "m1",
              providerId: "p_openai",
              providerModel: "gpt-4o",
              aliases: [],
              attachments: { image: true, pdf: true },
            },
            {
              id: "m2",
              providerId: "p_openai",
              providerModel: "gpt-4o-mini",
              aliases: [],
              attachments: { image: true },
            },
            {
              id: "m3",
              providerId: "p_anthropic",
              providerModel: "kimi-k2.7-code",
              aliases: [],
              attachments: {},
            },
          ] as unknown as readonly ModelRoute[]
        }
        providerNames={{}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(screen.getByText("images + PDFs")).toBeInTheDocument()
    expect(screen.getByText("images")).toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
  })
  it("renders joined aliases for a model row", () => {
    render(
      <ModelTable
        models={models}
        providerNames={providerNames}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(screen.getByText("haiku, small")).toBeInTheDocument()
  })
  it("renders a row for each model with the resolved provider name", () => {
    render(
      <ModelTable
        models={models}
        providerNames={providerNames}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("claude-3-5-sonnet")).toBeInTheDocument()
  })
  it("falls back to the provider id when no name is known", () => {
    render(
      <ModelTable
        models={models}
        providerNames={{}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(screen.getByText("p_openai")).toBeInTheDocument()
  })
  it("calls onEdit with the id when a row's edit button is clicked", () => {
    const onEdit = mock((_a: string) => {})
    render(
      <ModelTable
        models={models}
        providerNames={providerNames}
        onEdit={onEdit}
        onDelete={() => {}}
      />,
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: /edit/i })[0] as HTMLElement,
    )
    expect(onEdit).toHaveBeenCalledWith("mdl_fast")
  })
  it("shows an empty state when there are no models", () => {
    render(
      <ModelTable
        models={[]}
        providerNames={providerNames}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(
      screen.getByRole("heading", { name: /no models yet/i }),
    ).toBeInTheDocument()
  })
})
