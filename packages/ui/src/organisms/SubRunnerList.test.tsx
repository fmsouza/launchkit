import { describe, expect, it } from "bun:test"
import {
  type CanonicalEvent,
  type RunState,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import { RunnerIdSchema } from "@spectrum/types"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SubRunnerList } from "./SubRunnerList"

const root = RunnerIdSchema.parse("run_root")
const childA = RunnerIdSchema.parse("run_a")
const childB = RunnerIdSchema.parse("run_b")

// Root started, then two children spawned (A still running, B completed).
const state: RunState = (
  [
    { type: "runner-started", runnerId: root, title: "main" },
    {
      type: "runner-started",
      runnerId: childA,
      parentRunnerId: root,
      spawnedByCallId: "c1",
      title: "search docs",
    },
    {
      type: "runner-started",
      runnerId: childB,
      parentRunnerId: root,
      spawnedByCallId: "c2",
      title: "refactor module",
    },
    { type: "runner-finished", runnerId: childB, status: "completed" },
  ] satisfies readonly CanonicalEvent[]
).reduce(reduce, initialRunState)

describe("SubRunnerList", () => {
  it("renders one row per non-root runner", () => {
    render(
      <SubRunnerList
        runners={state.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText("search docs")).toBeInTheDocument()
    expect(screen.getByText("refactor module")).toBeInTheDocument()
    cleanup()
  })

  it("excludes the root runner from the roster", () => {
    render(
      <SubRunnerList
        runners={state.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    // The root's title must not appear as a roster row. The empty-state hint
    // must not appear either (two children exist).
    expect(screen.queryByText("main")).toBeNull()
    expect(screen.queryByText(/No agents yet/i)).toBeNull()
    cleanup()
  })

  it("derives the root from parentRunnerId when rootRunnerId is omitted", () => {
    render(<SubRunnerList runners={state.runners} onOpen={() => {}} />)
    expect(screen.getByText("search docs")).toBeInTheDocument()
    expect(screen.queryByText("main")).toBeNull()
    cleanup()
  })

  it("sorts running agents first, preserving spawn order within each group", () => {
    const { container } = render(
      <SubRunnerList
        runners={state.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    const details = Array.from(
      container.querySelectorAll(".lk-sub-runner-card__detail"),
    ).map((el) => el.textContent)
    // childA is running; childB completed → A first, then B. The started-for
    // text (the child titles "search docs" / "refactor module") is now the detail.
    expect(details).toEqual(["search docs", "refactor module"])
    cleanup()
  })

  it("shows the literal title Agent and the started-for detail, not the agentType", () => {
    // A child with BOTH a title and an agentType: under the old logic the title
    // span showed the title and the detail showed the agentType. Under the new
    // logic the title span is "Agent" and the detail shows the started-for text
    // (subRunnerDetail prefers the child title, so the detail is the title).
    const withType: RunState = (
      [
        { type: "runner-started", runnerId: root, title: "main" },
        {
          type: "tool-call-started",
          runnerId: root,
          callId: "c1",
          tool: "Task",
          input: { description: "ignored because child has title" },
        },
        {
          type: "runner-started",
          runnerId: childA,
          parentRunnerId: root,
          spawnedByCallId: "c1",
          title: "search docs",
          agentType: "general-purpose",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const { container } = render(
      <SubRunnerList
        runners={withType.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    const titles = container.querySelectorAll(".lk-sub-runner-card__title")
    expect(titles.length).toBe(1)
    expect(titles[0]?.textContent).toBe("Agent")
    // The detail is the started-for text (subRunnerDetail returns the child
    // title "search docs"); the agentType "general-purpose" is NOT shown.
    expect(
      container.querySelector(".lk-sub-runner-card__detail")?.textContent,
    ).toBe("search docs")
    expect(container.textContent ?? "").not.toContain("general-purpose")
    cleanup()
  })

  it("derives the detail from the parent tool-call description when the child has no title", () => {
    const noTitle: RunState = (
      [
        { type: "runner-started", runnerId: root, title: "main" },
        {
          type: "tool-call-started",
          runnerId: root,
          callId: "c1",
          tool: "Task",
          input: { description: "Investigate tool rendering" },
        },
        {
          type: "runner-started",
          runnerId: childA,
          parentRunnerId: root,
          spawnedByCallId: "c1",
          agentType: "general-purpose",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    render(
      <SubRunnerList
        runners={noTitle.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText("Investigate tool rendering")).toBeInTheDocument()
    expect(screen.queryByText("general-purpose")).toBeNull()
    cleanup()
  })

  it("shows an empty-state hint when only the root exists", () => {
    const onlyRoot: RunState = (
      [
        { type: "runner-started", runnerId: root, title: "main" },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    render(
      <SubRunnerList
        runners={onlyRoot.runners}
        rootRunnerId={root}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText(/No agents yet/i)).toBeInTheDocument()
    // The roster container's accessible name aligns with the "Agents" rail tab.
    expect(screen.getByLabelText("Agents")).toBeInTheDocument()
    cleanup()
  })

  it("calls onOpen with the runner id when a row is pressed", () => {
    let opened: string | undefined
    render(
      <SubRunnerList
        runners={state.runners}
        rootRunnerId={root}
        onOpen={(id) => {
          opened = String(id)
        }}
      />,
    )
    fireEvent.click(screen.getByText("search docs"))
    expect(opened).toBe(String(childA))
    cleanup()
  })

  it("marks the focused runner's row as current", () => {
    render(
      <SubRunnerList
        runners={state.runners}
        rootRunnerId={root}
        openRunnerId={childA}
        onOpen={() => {}}
      />,
    )
    const focused = screen
      .getByText("search docs")
      .closest('li[aria-current="true"]')
    expect(focused).not.toBeNull()
    cleanup()
  })
})
