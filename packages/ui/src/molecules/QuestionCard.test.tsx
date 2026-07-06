import { describe, expect, it } from "bun:test"
import type { Question, QuestionItem } from "@spectrum/agent-events"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QuestionCard, allAnswered, isAnswered } from "./QuestionCard"

const item: QuestionItem = {
  kind: "question",
  requestId: "q1",
  prompt: {
    questions: [
      {
        question: "Which library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "lightweight" },
          { label: "day.js", description: "tiny" },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  },
}

const multi: QuestionItem = {
  kind: "question",
  requestId: "q2",
  prompt: {
    questions: [
      {
        question: "Which provider?",
        header: "Provider",
        options: [{ label: "Anthropic" }, { label: "OpenAI" }],
        multiSelect: false,
        allowFreeText: false,
      },
      {
        question: "Which region?",
        header: "Region",
        options: [{ label: "us" }, { label: "eu" }],
        multiSelect: false,
        allowFreeText: false,
      },
    ],
  },
}

describe("QuestionCard", () => {
  it("renders the question, header and options", () => {
    render(<QuestionCard item={item} onAnswer={() => {}} />)
    expect(screen.getByText("Which library?")).toBeInTheDocument()
    expect(screen.getByText("Library")).toBeInTheDocument()
    expect(screen.getByText("date-fns")).toBeInTheDocument()
    cleanup()
  })

  it("submits the selected option as an index-keyed answer", () => {
    let got: unknown
    render(
      <QuestionCard
        item={item}
        onAnswer={(a) => {
          got = a
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText("date-fns"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(got).toEqual({
      selections: [{ questionIndex: 0, labels: ["date-fns"] }],
    })
    cleanup()
  })

  it("disables inputs when inert and unanswered", () => {
    render(<QuestionCard item={item} onAnswer={() => {}} inert />)
    expect(screen.getByLabelText("date-fns")).toBeDisabled()
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled()
    cleanup()
  })

  it("includes the free-text Other value in the submitted answer", () => {
    let got: unknown
    render(
      <QuestionCard
        item={item}
        onAnswer={(a) => {
          got = a
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText("date-fns"))
    fireEvent.change(screen.getByLabelText("Other"), {
      target: { value: "moment" },
    })
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(got).toEqual({
      selections: [
        { questionIndex: 0, labels: ["date-fns"], freeText: "moment" },
      ],
    })
    cleanup()
  })

  it("shows the resolved answer (inert) when already answered", () => {
    render(
      <QuestionCard
        item={{
          ...item,
          answer: { selections: [{ questionIndex: 0, labels: ["day.js"] }] },
        }}
        onAnswer={() => {}}
      />,
    )
    expect(screen.getByText(/day\.js/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    cleanup()
  })

  it("shows the original question text and the chosen answer in the resolved state", () => {
    const q = item.prompt.questions[0]
    const answered = {
      ...item,
      answer: {
        selections: [
          { questionIndex: 0, labels: [q?.options[0]?.label ?? ""] },
        ],
      },
    }
    render(<QuestionCard item={answered} onAnswer={() => {}} />)
    // The question is echoed so it stays clear what was asked.
    expect(screen.getByText(q?.question ?? "")).toBeInTheDocument()
    // The chosen answer is shown.
    expect(
      screen.getByText(new RegExp(q?.options[0]?.label ?? "")),
    ).toBeInTheDocument()
    cleanup()
  })

  it("shows a free-text answer in the resolved state", () => {
    const q = item.prompt.questions[0]
    const answered = {
      ...item,
      answer: {
        selections: [
          { questionIndex: 0, labels: [], freeText: "custom reply" },
        ],
      },
    }
    render(<QuestionCard item={answered} onAnswer={() => {}} />)
    expect(screen.getByText(q?.question ?? "")).toBeInTheDocument()
    expect(screen.getByText("custom reply")).toBeInTheDocument()
    cleanup()
  })

  it("groups each option's label and description in one stacking container, separate from the radio", () => {
    render(<QuestionCard item={item} onAnswer={() => {}} />)
    const label = screen.getByText(
      item.prompt.questions[0]?.options[0]?.label ?? "",
    )
    const wrapper = label.closest(".lk-question__opt-text")
    expect(wrapper).not.toBeNull()
    // The description (if any) lives in the SAME wrapper as the label…
    const desc = item.prompt.questions[0]?.options[0]?.description
    if (desc !== undefined)
      expect(wrapper).toContainElement(screen.getByText(desc))
    // …and the radio/checkbox is NOT inside that text wrapper (it stays beside it).
    const opt = label.closest(".lk-question__opt")
    expect(
      opt?.querySelector("input")?.closest(".lk-question__opt-text"),
    ).toBeNull()
    cleanup()
  })

  it("renders one question visible at a time with hidden panels for others when unanswered", () => {
    const { container } = render(
      <QuestionCard item={multi} onAnswer={() => {}} />,
    )
    // The current panel is the only one in the accessibility tree.
    expect(screen.getByText("Which provider?")).toBeInTheDocument()
    expect(screen.queryByRole("tabpanel", { hidden: false })).not.toBeNull()
    // Hidden panels exist in the DOM but are excluded from the a11y tree.
    const panels = container.querySelectorAll('[role="tabpanel"]')
    expect(panels).toHaveLength(2)
    expect(panels[1]).toHaveAttribute("hidden")
    expect(
      screen.getByRole("tab", { name: /1\. Provider/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /2\. Region/ })).toBeInTheDocument()
    cleanup()
  })

  it("disables Next until the current question is answered", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled()
    fireEvent.click(screen.getByLabelText("Anthropic"))
    expect(screen.getByRole("button", { name: /next/i })).toBeEnabled()
    cleanup()
  })

  it("advances to the next question on Next and shows Back", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    expect(screen.getByText("Which region?")).toBeInTheDocument()
    // The previous panel is now hidden from the accessibility tree.
    expect(
      screen.queryByRole("tabpanel", { hidden: false })?.textContent,
    ).toContain("Which region?")
    expect(screen.getByRole("button", { name: /back/i })).toBeEnabled()
    cleanup()
  })

  it("disables Back on the first step and shows Submit only on the last step", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled()
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    fireEvent.click(screen.getByLabelText("us"))
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
    cleanup()
  })

  it("marks a tab as answered with a checkmark once its question has a selection", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    const providerTab = screen.getByRole("tab", { name: /1\. Provider/ })
    expect(providerTab.getAttribute("data-state")).toBe("answered")
    expect(providerTab.querySelector(".lk-question__tab-check")).not.toBeNull()
    cleanup()
  })

  it("clears the checkmark when a previously answered question is cleared", () => {
    // Uses a multiSelect fixture so a checkbox click toggles off (single-select
    // radios do not deselect under the current `toggle`). Navigates AWAY from
    // step 0 before asserting because `tabState` always returns "current" for
    // `qi === step` regardless of answered status.
    const multiSelect: QuestionItem = {
      kind: "question",
      requestId: "q3",
      prompt: {
        questions: [
          {
            question: "Which providers?",
            header: "Providers",
            options: [{ label: "Anthropic" }, { label: "OpenAI" }],
            multiSelect: true,
            allowFreeText: false,
          },
          {
            question: "Which region?",
            header: "Region",
            options: [{ label: "us" }, { label: "eu" }],
            multiSelect: false,
            allowFreeText: false,
          },
        ],
      },
    }
    render(<QuestionCard item={multiSelect} onAnswer={() => {}} />)
    // Step 0: pick Anthropic.
    fireEvent.click(screen.getByLabelText("Anthropic"))
    // Advance to step 1 — tab 0 should be answered + checkmark.
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    // Go back to step 0, then clear the selection by clicking again (multiSelect).
    fireEvent.click(screen.getByRole("button", { name: /back/i }))
    fireEvent.click(screen.getByLabelText("Anthropic"))
    // Advance away from step 0 so tabState evaluates the answered branch
    // (jump directly via tab click — Next is disabled because step 0 is now empty).
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    const providersTab = screen.getByRole("tab", { name: /1\. Providers/ })
    expect(providersTab.getAttribute("data-state")).toBe("todo")
    expect(providersTab.querySelector(".lk-question__tab-check")).toBeNull()
    cleanup()
  })

  it("jumps directly to a question when its tab is clicked", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    expect(screen.getByText("Which region?")).toBeInTheDocument()
    expect(
      screen
        .getByRole("tab", { name: /2\. Region/ })
        .getAttribute("data-state"),
    ).toBe("current")
    cleanup()
  })

  it("disables Submit on the last step until every question is answered", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    fireEvent.click(screen.getByLabelText("us"))
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled() // first still unanswered
    fireEvent.click(screen.getByRole("tab", { name: /1\. Provider/ }))
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled()
    cleanup()
  })

  it("submits a selection per question with correct questionIndex on final Submit", () => {
    let got: unknown
    render(
      <QuestionCard
        item={multi}
        onAnswer={(a) => {
          got = a
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    fireEvent.click(screen.getByLabelText("eu"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(got).toEqual({
      selections: [
        { questionIndex: 0, labels: ["Anthropic"] },
        { questionIndex: 1, labels: ["eu"] },
      ],
    })
    cleanup()
  })

  it("preserves drafts across Back/Next navigation", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("button", { name: /next/i }))
    fireEvent.click(screen.getByRole("button", { name: /back/i }))
    expect(screen.getByLabelText("Anthropic")).toBeChecked()
    cleanup()
  })

  it("shows only Submit with no Back/Next for a single-question prompt", () => {
    render(<QuestionCard item={item} onAnswer={() => {}} />)
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument()
    cleanup()
  })

  it("still renders the flat resolved list when item.answer is present", () => {
    render(
      <QuestionCard
        item={{
          ...multi,
          answer: {
            selections: [
              { questionIndex: 0, labels: ["OpenAI"] },
              { questionIndex: 1, labels: ["eu"] },
            ],
          },
        }}
        onAnswer={() => {}}
      />,
    )
    expect(screen.getByText("Which provider?")).toBeInTheDocument()
    expect(screen.getByText("Which region?")).toBeInTheDocument()
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    cleanup()
  })

  it("renders one panel per question and hides non-current ones", () => {
    const { container } = render(
      <QuestionCard item={multi} onAnswer={() => {}} />,
    )
    // Hidden panels are excluded from the accessibility tree, so query the DOM
    // directly to verify every panel exists in the markup.
    const panels = container.querySelectorAll('[role="tabpanel"]')
    expect(panels).toHaveLength(2)
    // Step 0: panel 0 is the current (visible) one, panel 1 is hidden.
    expect(panels[0]).not.toHaveAttribute("hidden")
    expect(panels[1]).toHaveAttribute("hidden")
    cleanup()
  })

  it("moves to the next tab on ArrowRight and focuses it", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tab0 = screen.getByRole("tab", { name: /1\. Provider/ })
    const tab1 = screen.getByRole("tab", { name: /2\. Region/ })
    tab0.focus()
    expect(document.activeElement).toBe(tab0)
    fireEvent.keyDown(tab0, { key: "ArrowRight" })
    expect(document.activeElement).toBe(tab1)
    expect(tab1.getAttribute("aria-selected")).toBe("true")
    cleanup()
  })

  it("moves to the previous tab on ArrowLeft and focuses it", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tab0 = screen.getByRole("tab", { name: /1\. Provider/ })
    const tab1 = screen.getByRole("tab", { name: /2\. Region/ })
    // Advance to step 1 via tab click; clicks don't focus buttons in jsdom.
    fireEvent.click(tab1)
    tab1.focus()
    expect(document.activeElement).toBe(tab1)
    fireEvent.keyDown(tab1, { key: "ArrowLeft" })
    expect(document.activeElement).toBe(tab0)
    expect(tab0.getAttribute("aria-selected")).toBe("true")
    cleanup()
  })

  it("wraps around from last to first on ArrowRight", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tab0 = screen.getByRole("tab", { name: /1\. Provider/ })
    const tab1 = screen.getByRole("tab", { name: /2\. Region/ })
    fireEvent.click(tab1)
    tab1.focus()
    expect(document.activeElement).toBe(tab1)
    fireEvent.keyDown(tab1, { key: "ArrowRight" })
    expect(document.activeElement).toBe(tab0)
    expect(tab0.getAttribute("aria-selected")).toBe("true")
    cleanup()
  })

  it("wraps around from first to last on ArrowLeft", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tab0 = screen.getByRole("tab", { name: /1\. Provider/ })
    const tab1 = screen.getByRole("tab", { name: /2\. Region/ })
    tab0.focus()
    expect(document.activeElement).toBe(tab0)
    fireEvent.keyDown(tab0, { key: "ArrowLeft" })
    expect(document.activeElement).toBe(tab1)
    expect(tab1.getAttribute("aria-selected")).toBe("true")
    cleanup()
  })

  it("goes to first on Home and last on End", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tab0 = screen.getByRole("tab", { name: /1\. Provider/ })
    const tab1 = screen.getByRole("tab", { name: /2\. Region/ })
    // Start at step 1.
    fireEvent.click(tab1)
    tab1.focus()
    expect(document.activeElement).toBe(tab1)
    fireEvent.keyDown(tab1, { key: "Home" })
    expect(document.activeElement).toBe(tab0)
    expect(tab0.getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(tab0, { key: "End" })
    expect(document.activeElement).toBe(tab1)
    expect(tab1.getAttribute("aria-selected")).toBe("true")
    cleanup()
  })
})

describe("QuestionCard wizard DOM", () => {
  // Structural / a11y contract for the wizard shell. These assertions lock the
  // shape of the rendered DOM (data-wizard root, tablist/tab/tabpanel roles,
  // nav button counts, resolved-state guard) so future refactors of QuestionCard
  // can't silently regress the breadcrumb UI without breaking tests here.
  it("marks the interactive root with data-wizard", () => {
    const { container } = render(
      <QuestionCard item={multi} onAnswer={() => {}} />,
    )
    expect(container.querySelector("[data-wizard]")).not.toBeNull()
    cleanup()
  })

  it("renders a tablist with role + aria-label", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tablist = screen.getByRole("tablist")
    expect(tablist.getAttribute("aria-label")).toBeTruthy()
    cleanup()
  })

  it("renders each tab as a button with role=tab, aria-selected and data-state", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    for (const tab of tabs) {
      expect(tab.tagName).toBe("BUTTON")
      const selected = tab.getAttribute("aria-selected")
      expect(selected === "true" || selected === "false").toBe(true)
      const state = tab.getAttribute("data-state")
      if (state === null) throw new Error("expected data-state attribute")
      expect(["current", "answered", "todo"]).toContain(state)
    }
    cleanup()
  })

  it("renders each panel with role=tabpanel and aria-labelledby matching its tab id", () => {
    const { container } = render(
      <QuestionCard item={multi} onAnswer={() => {}} />,
    )
    // Hidden panels are excluded from the accessibility tree — query the DOM.
    const panels = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    )
    const tabs = screen.getAllByRole("tab")
    expect(panels).toHaveLength(tabs.length)
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i] as HTMLElement
      const tab = tabs[i] as HTMLElement
      const tabId = tab.getAttribute("id")
      expect(panel.getAttribute("aria-labelledby")).toBe(tabId)
      // Each tab's aria-controls must resolve to the matching panel id.
      expect(tab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"))
    }
    cleanup()
  })

  it("shows at most one of {submit, next} at a time (not both)", () => {
    // Single-question: submit only, no next.
    render(<QuestionCard item={item} onAnswer={() => {}} />)
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument()
    cleanup()
    // Multi-question on step 0: next only, no submit.
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument()
    cleanup()
  })

  it("hides Back and Next for a single-question prompt", () => {
    render(<QuestionCard item={item} onAnswer={() => {}} />)
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
    cleanup()
  })

  it("shows a single Submit button on the last step when every question is answered", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    fireEvent.click(screen.getByLabelText("us"))
    fireEvent.click(screen.getByRole("tab", { name: /1\. Provider/ }))
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    const submits = screen.getAllByRole("button", { name: /submit/i })
    expect(submits).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
    cleanup()
  })

  it("renders a .lk-question__tab-check only on answered tabs", () => {
    render(<QuestionCard item={multi} onAnswer={() => {}} />)
    const currentTab = screen.getByRole("tab", { name: /1\. Provider/ })
    expect(currentTab.querySelector(".lk-question__tab-check")).toBeNull()
    // Answer step 0 then move away so tabState evaluates the answered branch.
    fireEvent.click(screen.getByLabelText("Anthropic"))
    fireEvent.click(screen.getByRole("tab", { name: /2\. Region/ }))
    const answeredTab = screen.getByRole("tab", { name: /1\. Provider/ })
    expect(answeredTab.getAttribute("data-state")).toBe("answered")
    expect(answeredTab.querySelector(".lk-question__tab-check")).not.toBeNull()
    const todoTab = screen.getByRole("tab", { name: /2\. Region/ })
    expect(todoTab.querySelector(".lk-question__tab-check")).toBeNull()
    cleanup()
  })

  it("renders the flat resolved view when item.answer is present (no wizard chrome)", () => {
    const { container } = render(
      <QuestionCard
        item={{
          ...multi,
          answer: {
            selections: [
              { questionIndex: 0, labels: ["Anthropic"] },
              { questionIndex: 1, labels: ["eu"] },
            ],
          },
        }}
        onAnswer={() => {}}
      />,
    )
    expect(container.querySelector("[data-wizard]")).toBeNull()
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    cleanup()
  })
})

describe("QuestionCard helpers", () => {
  const multiOpt: Question = {
    question: "q",
    header: "h",
    options: [{ label: "a" }, { label: "b" }],
    multiSelect: false,
    allowFreeText: false,
  }
  const freeTextOnly: Question = {
    question: "q",
    header: "h",
    options: [],
    multiSelect: false,
    allowFreeText: true,
  }
  const empty: Question = {
    question: "q",
    header: "h",
    options: [],
    multiSelect: false,
    allowFreeText: false,
  }

  it("isAnswered is false when no labels and no free text", () => {
    expect(isAnswered({ labels: [], freeText: "" }, multiOpt)).toBe(false)
  })

  it("isAnswered is true when a label is selected", () => {
    expect(isAnswered({ labels: ["a"], freeText: "" }, multiOpt)).toBe(true)
  })

  it("isAnswered is true when free text is present and allowed", () => {
    expect(isAnswered({ labels: [], freeText: "custom" }, freeTextOnly)).toBe(
      true,
    )
  })

  it("isAnswered ignores free text when allowFreeText is false", () => {
    expect(isAnswered({ labels: [], freeText: "custom" }, multiOpt)).toBe(false)
  })

  it("isAnswered treats a question with no options and no free text as answered by default", () => {
    expect(isAnswered({ labels: [], freeText: "" }, empty)).toBe(true)
  })

  it("allAnswered is true only when every question is answered", () => {
    const qs = [multiOpt, freeTextOnly] as const
    expect(
      allAnswered(
        [
          { labels: [], freeText: "" },
          { labels: [], freeText: "x" },
        ],
        qs,
      ),
    ).toBe(false)
    expect(
      allAnswered(
        [
          { labels: ["a"], freeText: "" },
          { labels: [], freeText: "x" },
        ],
        qs,
      ),
    ).toBe(true)
  })
})
