import { describe, expect, it } from "bun:test"
import type { ModelRoute } from "@spectrum/types"
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { Composer, growTextareaHeight, resolveMaxHeightPx } from "./Composer"

describe("Composer", () => {
  it("calls onSend with the typed text when Send is clicked", () => {
    let sent: { text: string; attachments?: readonly unknown[] } | undefined
    render(
      <Composer
        onSend={(t) => {
          sent = t
        }}
      />,
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "do the thing" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(sent?.text).toBe("do the thing")
    cleanup()
  })

  it("does not call onSend for whitespace-only input", () => {
    let calls = 0
    render(
      <Composer
        onSend={() => {
          calls += 1
        }}
      />,
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(calls).toBe(0)
    cleanup()
  })

  it("clears the field after a successful send", () => {
    render(<Composer onSend={() => {}} />)
    const box = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(box.value).toBe("")
    cleanup()
  })

  it("disables the input and button when disabled", () => {
    render(<Composer onSend={() => {}} disabled />)
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    cleanup()
  })

  it("sends on Enter and clears the field", () => {
    let sent: { text: string; attachments?: readonly unknown[] } | undefined
    render(
      <Composer
        onSend={(t) => {
          sent = t
        }}
      />,
    )
    const box = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "ship it" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(sent?.text).toBe("ship it")
    expect(box.value).toBe("")
    cleanup()
  })

  it("does NOT send on Shift+Enter (newline instead)", () => {
    let calls = 0
    render(
      <Composer
        onSend={() => {
          calls += 1
        }}
      />,
    )
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "line one" } })
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(calls).toBe(0)
    cleanup()
  })

  it("shows a stop button instead of send while busy and fires onInterrupt", () => {
    let interrupted = 0
    render(
      <Composer
        onSend={() => {}}
        busy
        onInterrupt={() => {
          interrupted += 1
        }}
      />,
    )
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }))
    expect(interrupted).toBe(1)
    cleanup()
  })

  it("keeps the textarea enabled while busy so the user can steer", () => {
    render(<Composer onSend={() => {}} busy onInterrupt={() => {}} />)
    expect(screen.getByRole("textbox")).toBeEnabled()
    cleanup()
  })

  it("disables the send button when the input is empty", () => {
    render(<Composer onSend={() => {}} />)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    cleanup()
  })

  it("renders the mode selector and forwards mode changes", () => {
    let picked: string | undefined
    render(
      <Composer
        onSend={() => {}}
        mode="manual"
        supportedModes={["manual", "plan"]}
        onModeChange={(m) => {
          picked = m
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /manual approval/i }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /plan mode/i }))
    expect(picked).toBe("plan")
    cleanup()
  })

  it("hides the mode selector when no modes are provided", () => {
    render(<Composer onSend={() => {}} />)
    expect(screen.queryByRole("button", { name: /approval/i })).toBeNull()
    cleanup()
  })

  it("renders the model selector beside the mode selector and forwards model changes", () => {
    const models = [
      { id: "mdl_default", providerId: "p1", providerModel: "sonnet" },
      { id: "mdl_fast", providerId: "p1", providerModel: "haiku" },
    ] as unknown as readonly ModelRoute[]
    let picked: string | undefined
    render(
      <Composer
        onSend={() => {}}
        mode="manual"
        supportedModes={["manual", "plan"]}
        onModeChange={() => {}}
        model=""
        models={models}
        providerNames={{ p1: "Anthropic" }}
        onModelChange={(m) => {
          picked = m
        }}
      />,
    )
    // Both selectors render
    expect(
      screen.getByRole("button", { name: /manual approval/i }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /default/i }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Anthropic \/ haiku/i }),
    )
    expect(picked).toBe("mdl_fast")
    cleanup()
  })

  it("hides the model selector when models/onModelChange are not provided", () => {
    render(<Composer onSend={() => {}} />)
    expect(screen.queryByRole("button", { name: /default/i })).toBeNull()
    cleanup()
  })

  it("renders the thinking-effort selector when effort + onEffortChange are provided", () => {
    const { getByText } = render(
      <Composer onSend={() => {}} effort="medium" onEffortChange={() => {}} />,
    )
    expect(getByText("Medium")).toBeTruthy()
  })

  it("fills the textarea when prefillKey changes", () => {
    const { rerender } = render(<Composer onSend={() => {}} />)
    rerender(
      <Composer
        onSend={() => {}}
        prefillText="restored draft"
        prefillKey="k1"
      />,
    )
    const ta = screen.getByPlaceholderText(
      /Send a message/,
    ) as HTMLTextAreaElement
    expect(ta.value).toBe("restored draft")
  })

  it("applies an inline height to the textarea as the user types", () => {
    // jsdom returns 0px for computed max-height, which the fallback turns
    // into innerHeight/3 — a positive number, so the helper clamps to 160.
    const { container } = render(<Composer onSend={() => {}} />)
    const textarea = container.querySelector(
      ".lk-composer__input",
    ) as HTMLTextAreaElement
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 160,
    })
    fireEvent.input(textarea, { target: { value: "a".repeat(500) } })
    expect(textarea.style.height).toMatch(/^\d+(\.\d+)?px$/)
    cleanup()
  })

  it("collapses the textarea height back to auto after a successful send", () => {
    const { container } = render(<Composer onSend={() => {}} />)
    const textarea = container.querySelector(
      ".lk-composer__input",
    ) as HTMLTextAreaElement
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 160,
    })
    fireEvent.input(textarea, { target: { value: "do the thing" } })
    expect(textarea.style.height).toMatch(/^\d+(\.\d+)?px$/)
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(textarea.style.height).toBe("auto")
    cleanup()
  })

  it("hides the attach button when attachmentCapabilities is all-false", () => {
    const { container } = render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={{ image: false, pdf: false, binary: false }}
      />,
    )
    expect(container.querySelector('[data-action="attach"]')).toBeNull()
    cleanup()
  })

  it("shows the attach button when attachmentCapabilities has image true", () => {
    const { container } = render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={{ image: true, pdf: false, binary: false }}
      />,
    )
    expect(container.querySelector('[data-action="attach"]')).toBeTruthy()
    cleanup()
  })

  it("calls onPickAttachments when the attach button is clicked", () => {
    let picked = false
    const { container } = render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={{ image: true, pdf: false, binary: false }}
        onPickAttachments={() => {
          picked = true
        }}
      />,
    )
    const btn = container.querySelector('[data-action="attach"]') as HTMLElement
    fireEvent.click(btn)
    expect(picked).toBe(true)
    cleanup()
  })

  it("onSend receives attachments from pendingAttachments on submit", () => {
    let received: { text: string; attachments?: readonly unknown[] } | undefined
    render(
      <Composer
        onSend={(turn) => {
          received = turn
        }}
        pendingAttachments={[
          {
            id: "h1",
            mime: "image/png",
            displayName: "p.png",
            kind: "image",
            bytes: 1,
          },
        ]}
      />,
    )
    const box = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "hi" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(received).toBeDefined()
    expect(received?.text).toBe("hi")
    expect(received?.attachments).toBeArrayOfSize(1)
    cleanup()
  })

  const caps = { image: true, pdf: false, binary: false }
  const fileDrag = (
    files: File[] = [],
  ): {
    dataTransfer: { types: string[]; files: File[]; dropEffect: string }
  } => ({
    dataTransfer: { types: ["Files"], files, dropEffect: "none" },
  })
  const composerEl = (): Element => {
    const el = document.querySelector(".lk-composer")
    if (el === null) throw new Error("composer not rendered")
    return el
  }

  it("renders attach and send inside the right-aligned actions group", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onPickAttachments={() => {}}
      />,
    )
    const group = document.querySelector(".lk-composer__actions")
    expect(group).not.toBeNull()
    expect(group).toContainElement(
      screen.getByRole("button", { name: "Attach files" }),
    )
    expect(group).toContainElement(
      screen.getByRole("button", { name: "Send message" }),
    )
    cleanup()
  })

  it("highlights the composer while a file drag hovers it and clears on leave", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    expect(composerEl()).toHaveClass("lk-composer--drop-active")
    fireEvent.dragLeave(composerEl(), fileDrag())
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    cleanup()
  })

  it("keeps the highlight while the drag crosses child elements (enter/leave depth)", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    // Entering a child fires another dragenter that bubbles to the composer…
    fireEvent.dragEnter(screen.getByRole("textbox"), fileDrag())
    // …followed by a dragleave from the parent surface. Still one hover overall.
    fireEvent.dragLeave(composerEl(), fileDrag())
    expect(composerEl()).toHaveClass("lk-composer--drop-active")
    fireEvent.dragLeave(screen.getByRole("textbox"), fileDrag())
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    cleanup()
  })

  it("delivers dropped files to onDropFiles and clears the highlight", () => {
    const received: string[][] = []
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={(files) => received.push(files.map((f) => f.name))}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    fireEvent.drop(
      composerEl(),
      fileDrag([
        new File(["a"], "a.png", { type: "image/png" }),
        new File(["b"], "b.png", { type: "image/png" }),
      ]),
    )
    expect(received).toEqual([["a.png", "b.png"]])
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    cleanup()
  })

  it("clears the drop highlight when the composer becomes disabled mid-drag", () => {
    const { rerender } = render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    expect(composerEl()).toHaveClass("lk-composer--drop-active")
    rerender(
      <Composer
        onSend={() => {}}
        disabled
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    cleanup()
  })

  it("ignores drags that carry no files (e.g. text selections)", () => {
    let calls = 0
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {
          calls += 1
        }}
      />,
    )
    const textDrag = {
      dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" },
    }
    fireEvent.dragEnter(composerEl(), textDrag)
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    fireEvent.drop(composerEl(), textDrag)
    expect(calls).toBe(0)
    cleanup()
  })

  it("stays inert to file drags when attachments are unsupported", () => {
    let calls = 0
    render(
      <Composer
        onSend={() => {}}
        onDropFiles={() => {
          calls += 1
        }}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    fireEvent.drop(
      composerEl(),
      fileDrag([new File(["a"], "a.png", { type: "image/png" })]),
    )
    expect(calls).toBe(0)
    cleanup()
  })

  it("stays inert to file drags while disabled", () => {
    let calls = 0
    render(
      <Composer
        onSend={() => {}}
        disabled
        attachmentCapabilities={caps}
        onDropFiles={() => {
          calls += 1
        }}
      />,
    )
    fireEvent.dragEnter(composerEl(), fileDrag())
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    fireEvent.drop(
      composerEl(),
      fileDrag([new File(["a"], "a.png", { type: "image/png" })]),
    )
    expect(calls).toBe(0)
    cleanup()
  })

  it("stays inert after an unbalanced dragLeave and still activates on the next dragEnter", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    // Leave with no prior enter: the depth clamp keeps state at 0 (no class)…
    fireEvent.dragLeave(composerEl(), fileDrag())
    expect(composerEl()).not.toHaveClass("lk-composer--drop-active")
    // …and ONE subsequent enter is enough to highlight (state never went negative).
    fireEvent.dragEnter(composerEl(), fileDrag())
    expect(composerEl()).toHaveClass("lk-composer--drop-active")
    cleanup()
  })

  it("accepts the drag on dragOver by preventing default and requesting a copy effect", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    const dt = { types: ["Files"], files: [], dropEffect: "none" }
    const event = createEvent.dragOver(composerEl())
    Object.defineProperty(event, "dataTransfer", { value: dt })
    fireEvent(composerEl(), event)
    expect(event.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe("copy")
    cleanup()
  })

  it("leaves non-file dragOver untouched", () => {
    render(
      <Composer
        onSend={() => {}}
        attachmentCapabilities={caps}
        onDropFiles={() => {}}
      />,
    )
    const dt = { types: ["text/plain"], files: [], dropEffect: "none" }
    const event = createEvent.dragOver(composerEl())
    Object.defineProperty(event, "dataTransfer", { value: dt })
    fireEvent(composerEl(), event)
    expect(event.defaultPrevented).toBe(false)
    expect(dt.dropEffect).toBe("none")
    cleanup()
  })
})

describe("growTextareaHeight", () => {
  // jsdom does not compute layout, so scrollHeight is 0 by default.
  // Stub it per element via Object.defineProperty.
  const stubScrollHeight = (el: HTMLTextAreaElement, value: number): void => {
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => value,
    })
  }

  it("returns scrollHeight when it is below maxHeight", () => {
    const el = document.createElement("textarea")
    stubScrollHeight(el, 120)
    expect(growTextareaHeight(el, 300)).toBe(120)
  })

  it("returns maxHeight when scrollHeight equals maxHeight", () => {
    const el = document.createElement("textarea")
    stubScrollHeight(el, 300)
    expect(growTextareaHeight(el, 300)).toBe(300)
  })

  it("returns maxHeight when scrollHeight exceeds maxHeight", () => {
    const el = document.createElement("textarea")
    stubScrollHeight(el, 900)
    expect(growTextareaHeight(el, 300)).toBe(300)
  })

  it("resets el.style.height to auto before measuring", () => {
    const el = document.createElement("textarea")
    el.style.height = "250px"
    stubScrollHeight(el, 120)
    growTextareaHeight(el, 300)
    expect(el.style.height).toBe("auto")
  })
})

describe("resolveMaxHeightPx", () => {
  it("returns the computed max-height in px when it is a usable pixel value", () => {
    const el = document.createElement("textarea")
    el.style.maxHeight = "300px"
    document.body.appendChild(el)
    expect(resolveMaxHeightPx(el)).toBe(300)
    el.remove()
  })

  it("falls back to innerHeight / 3 when computed max-height is not usable", () => {
    const el = document.createElement("textarea")
    // No max-height set → computed value resolves to a non-px form in jsdom.
    document.body.appendChild(el)
    const fallback = Math.floor(window.innerHeight / 3)
    expect(resolveMaxHeightPx(el)).toBe(fallback)
    el.remove()
  })
})
