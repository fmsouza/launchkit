import { describe, expect, it, mock } from "bun:test"
import type { HarnessDefinition } from "@spectrum/types"
import { fireEvent, render, screen } from "@testing-library/react"
import { NewSessionModal } from "./NewSessionModal"
import type { NewSessionValues } from "./NewSessionModal"

const harnesses = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
] as unknown as readonly HarnessDefinition[]

const baseProps = {
  open: true,
  harnesses,
  folder: "/Users/fred/app",
  onBrowse: () => {},
  onSubmit: () => {},
  onCancel: () => {},
}

describe("NewSessionModal", () => {
  it("does not render when closed", () => {
    render(<NewSessionModal {...baseProps} open={false} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("submits the selected harness and no modelId (model picker is gone)", () => {
    const onSubmit = mock((_v: NewSessionValues) => {})
    render(<NewSessionModal {...baseProps} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: /launch/i }))
    expect(onSubmit).toHaveBeenCalledWith({
      cwd: "/Users/fred/app",
      harnessId: "claude",
      env: {},
    })
  })
  it("calls onBrowse when the folder Browse button is clicked", () => {
    const onBrowse = mock(() => {})
    render(<NewSessionModal {...baseProps} onBrowse={onBrowse} />)
    fireEvent.click(screen.getByRole("button", { name: /browse/i }))
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })
  it("invokes onCancel via the modal header close control", () => {
    const onCancel = mock(() => {})
    render(<NewSessionModal {...baseProps} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("does not render a Cancel button", () => {
    render(<NewSessionModal {...baseProps} />)
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull()
  })

  it("preselects the harness from initialHarnessId when the modal opens", () => {
    render(<NewSessionModal {...baseProps} initialHarnessId="codex" />)
    expect(screen.getByLabelText("Harness")).toHaveValue("codex")
  })

  it("does not render a Model field (model selection lives in the composer)", () => {
    render(<NewSessionModal {...baseProps} />)
    expect(screen.queryByLabelText("Model")).toBeNull()
  })

  it("falls back to the first harness when initialHarnessId is unknown", () => {
    render(<NewSessionModal {...baseProps} initialHarnessId="ghost" />)
    expect(screen.getByLabelText("Harness")).toHaveValue("claude")
  })

  it("syncs folder input when folder prop changes (Fix 1)", () => {
    const { rerender } = render(<NewSessionModal {...baseProps} folder="/a" />)
    expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue("/a")
    rerender(<NewSessionModal {...baseProps} folder="/b" />)
    expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue("/b")
  })

  it("resets the folder when modal is reopened (Fix 3)", () => {
    const { rerender } = render(
      <NewSessionModal {...baseProps} folder="/initial" open />,
    )
    fireEvent.change(screen.getByRole("textbox", { name: /folder/i }), {
      target: { value: "/changed" },
    })
    rerender(<NewSessionModal {...baseProps} folder="/initial" open={false} />)
    rerender(<NewSessionModal {...baseProps} folder="/initial" open />)
    expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue(
      "/initial",
    )
  })

  it("preserves typed folder when the folder prop changes (Browse) while open", () => {
    const { rerender } = render(
      <NewSessionModal {...baseProps} folder="/a" open />,
    )
    // Simulate Browse updating the parent's folder while modal stays open
    rerender(<NewSessionModal {...baseProps} folder="/b" open />)
    expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue("/b")
  })

  it("launches without a modelId when no models are provided (model lives in the composer)", () => {
    const onSubmit = mock(() => {})
    render(
      <NewSessionModal
        open
        harnesses={[{ id: "claude", name: "Claude Code" } as HarnessDefinition]}
        folder="/tmp"
        onBrowse={() => {}}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Launch" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // The exactOptional invariant: no modelId is sent — model lives in the composer.
    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelId: expect.anything() }),
    )
  })

  it("enables Launch when a harness is available", () => {
    render(<NewSessionModal {...baseProps} />)
    expect(screen.getByRole("button", { name: /launch/i })).not.toBeDisabled()
  })

  it("renders the error prop as an alert (Bug 1)", () => {
    render(<NewSessionModal {...baseProps} error="failed to launch: boom" />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      /failed to launch: boom/i,
    )
  })

  it("does not render a Name field (Fix #3)", () => {
    render(<NewSessionModal {...baseProps} />)
    expect(screen.queryByLabelText("Name")).toBeNull()
  })

  it("omits name from the submitted values so the RunManager auto-derives it at runtime (Fix #3)", () => {
    const onSubmit = mock((_v: NewSessionValues) => {})
    render(<NewSessionModal {...baseProps} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: /launch/i }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ name: expect.anything() }),
    )
    // Explicit: name is absent (auto-derivation owns it).
    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ name: expect.anything() }),
    )
  })
})
