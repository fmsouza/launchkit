import { describe, expect, it } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { FlowStepView } from "./FlowStepView"

const noops = {
  onSubmit: (): void => {},
  onAck: (): void => {},
  onCancel: (): void => {},
  busy: false,
}

const passwordFormStep = {
  kind: "form" as const,
  title: "Sign in",
  fields: [
    {
      name: "token",
      label: "Token",
      kind: "password" as const,
      required: true,
    },
  ],
}

const everyStepKind = [
  passwordFormStep,
  {
    kind: "message" as const,
    title: "Heads up",
    body: "b",
    tone: "info" as const,
  },
  {
    kind: "open-external" as const,
    title: "Authorize",
    url: "https://e.com/a",
  },
  { kind: "await" as const, title: "Waiting", pollMs: 1000 },
  { kind: "done" as const, message: "Signed in" },
  { kind: "error" as const, message: "Auth denied" },
  { kind: "some-future-kind" as const },
]

describe("FlowStepView", () => {
  it("renders one input per field when the step is a form", () => {
    render(<FlowStepView step={passwordFormStep} {...noops} />)
    expect(screen.getByLabelText("Token")).toBeInTheDocument()
  })

  it("renders every field of a multi-field form, not just the first", () => {
    render(
      <FlowStepView
        step={{
          kind: "form",
          title: "Sign in",
          fields: [
            {
              name: "clientId",
              label: "Client ID",
              kind: "text",
              required: true,
            },
            {
              name: "token",
              label: "Token",
              kind: "password",
              required: true,
            },
          ],
        }}
        {...noops}
      />,
    )
    expect(screen.getByLabelText("Client ID")).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toBeInTheDocument()
  })

  it("masks a password field so a pasted token is not shoulder-readable", () => {
    render(<FlowStepView step={passwordFormStep} {...noops} />)
    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password")
  })

  it("calls onSubmit with the entered values when a form is submitted", () => {
    const seen: Record<string, string>[] = []
    render(
      <FlowStepView
        step={passwordFormStep}
        {...noops}
        onSubmit={(values) => seen.push(values)}
      />,
    )
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "sk-1" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue|submit/i }))
    expect(seen).toEqual([{ token: "sk-1" }])
  })

  it("disables submit while a required field is empty", () => {
    render(<FlowStepView step={passwordFormStep} {...noops} />)
    expect(
      screen.getByRole("button", { name: /continue|submit/i }),
    ).toBeDisabled()
  })

  it("renders a select's options when the field kind is select", () => {
    render(
      <FlowStepView
        step={{
          kind: "form",
          title: "Pick",
          fields: [
            {
              name: "region",
              label: "Region",
              kind: "select",
              required: true,
              options: [{ value: "eu", label: "Europe" }],
            },
          ],
        }}
        {...noops}
      />,
    )
    expect(screen.getByRole("option", { name: "Europe" })).toBeInTheDocument()
  })

  it("renders the title and body when the step is a message", () => {
    render(
      <FlowStepView
        step={{
          kind: "message",
          title: "Heads up",
          body: "Read this",
          tone: "info",
        }}
        {...noops}
      />,
    )
    expect(screen.getByText("Heads up")).toBeInTheDocument()
    expect(screen.getByText("Read this")).toBeInTheDocument()
  })

  it("renders a continue control that calls onAck for a message step", () => {
    let acks = 0
    render(
      <FlowStepView
        step={{ kind: "message", title: "Heads up", body: "b", tone: "info" }}
        {...noops}
        onAck={() => {
          acks += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(acks).toBe(1)
  })

  it("does not label the open-external button 'Authorize' since the browser already opened", () => {
    render(
      <FlowStepView
        step={{
          kind: "open-external",
          title: "Authorize",
          url: "https://e.com/a",
        }}
        {...noops}
      />,
    )
    expect(screen.queryByRole("button", { name: /^authorize$/i })).toBeNull()
  })

  it("calls onAck when the open-external continue control is clicked", () => {
    let acks = 0
    render(
      <FlowStepView
        step={{
          kind: "open-external",
          title: "Authorize",
          url: "https://e.com/a",
        }}
        {...noops}
        onAck={() => {
          acks += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /continue|done/i }))
    expect(acks).toBe(1)
  })

  it("shows the url so the user can see where they are being sent", () => {
    render(
      <FlowStepView
        step={{
          kind: "open-external",
          title: "Authorize",
          url: "https://e.com/a",
        }}
        {...noops}
      />,
    )
    expect(screen.getByText(/e\.com/)).toBeInTheDocument()
  })

  it("renders a spinner and no submit control when the step is await", () => {
    render(
      <FlowStepView
        step={{ kind: "await", title: "Waiting", pollMs: 1000 }}
        {...noops}
      />,
    )
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull()
  })

  it("renders the completion message when the step is done", () => {
    render(
      <FlowStepView step={{ kind: "done", message: "Signed in" }} {...noops} />,
    )
    expect(screen.getByText("Signed in")).toBeInTheDocument()
  })

  it("renders the failure message when the step is error", () => {
    render(
      <FlowStepView
        step={{ kind: "error", message: "Auth denied" }}
        {...noops}
      />,
    )
    expect(screen.getByText("Auth denied")).toBeInTheDocument()
  })

  it("renders a newer-Spectrum message and no submit control for an unknown step kind", () => {
    render(
      <FlowStepView step={{ kind: "some-future-kind" } as never} {...noops} />,
    )
    expect(screen.getByText(/newer Spectrum/i)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /continue|submit/i }),
    ).toBeNull()
  })

  it("disables every control while busy, filling the required field first so busy is the only reason", () => {
    render(<FlowStepView step={passwordFormStep} {...noops} busy />)
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "sk-1" },
    })
    for (const button of screen.getAllByRole("button")) {
      if (/cancel/i.test(button.textContent ?? "")) continue
      expect(button).toBeDisabled()
    }
  })

  it("does not disable cancel while busy, so a hung flow stays escapable", () => {
    render(<FlowStepView step={passwordFormStep} {...noops} busy />)
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled()
  })

  it("offers cancel on every step kind, including one this build doesn't recognize", () => {
    for (const step of everyStepKind) {
      const { unmount } = render(<FlowStepView step={step} {...noops} />)
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument()
      unmount()
    }
  })

  it("calls onCancel when cancel is clicked", () => {
    let cancels = 0
    render(
      <FlowStepView
        step={passwordFormStep}
        {...noops}
        onCancel={() => {
          cancels += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(cancels).toBe(1)
  })
})
