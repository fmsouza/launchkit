import { describe, expect, it } from "bun:test"
import {
  type CanonicalEvent,
  type RunState,
  type RunnerId,
  type RunnerState,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import { RunnerIdSchema } from "@spectrum/types"
import type { ModelRoute } from "@spectrum/types"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { RunView } from "./RunView"

const root = RunnerIdSchema.parse("run_root")
const child = RunnerIdSchema.parse("run_child")

const state: RunState = (
  [
    { type: "runner-started", runnerId: root },
    { type: "text-delta", runnerId: root, messageId: "m1", text: "Working" },
    {
      type: "runner-started",
      runnerId: child,
      parentRunnerId: root,
      title: "sub",
    },
    {
      type: "text-delta",
      runnerId: child,
      messageId: "m2",
      text: "child says hi",
    },
  ] satisfies readonly CanonicalEvent[]
).reduce(reduce, initialRunState)

const rootRunner = state.runners.get(root)
const childRunner = state.runners.get(child)
if (rootRunner === undefined || childRunner === undefined)
  throw new Error("missing runners")

const base = {
  root: rootRunner,
  runners: state.runners,
  subBreadcrumb: ["main", "sub"],
  onOpenSubRunner: () => {},
  onCloseSub: () => {},
  onSend: () => {},
  onDecide: () => {},
  onAnswer: () => {},
}

describe("RunView", () => {
  it("renders the root timeline content", () => {
    render(<RunView {...base} />)
    expect(screen.getByText("Working")).toBeInTheDocument()
    cleanup()
  })

  it("does not render the sub-runner pane when none is open", () => {
    render(<RunView {...base} />)
    expect(screen.queryByText("child says hi")).toBeNull()
    cleanup()
  })

  it("starts with the rail collapsed by default", () => {
    const rid = RunnerIdSchema.parse("run_root")
    const withTasks = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c1",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "First task",
                activeForm: "Doing first",
                status: "pending",
              },
            ],
          },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const runner = withTasks.runners.get(rid)
    if (runner === undefined) throw new Error("missing runner")

    render(<RunView {...base} root={runner} runners={withTasks.runners} />)
    // Collapsed strip is present (expand control visible), task content is not.
    expect(
      screen.getByRole("button", { name: "Expand tasks panel" }),
    ).toBeInTheDocument()
    // No Tasks tab in the expanded header yet.
    expect(screen.queryByRole("tab", { name: "Tasks" })).toBeNull()
    expect(screen.queryByText("First task")).toBeNull()
    cleanup()
  })

  it("renders the sub-runner pane content when a sub-runner is open", () => {
    render(<RunView {...base} openRunner={childRunner} />)
    expect(screen.getByText("child says hi")).toBeInTheDocument()
    cleanup()
  })

  it("auto-expands the rail to the focused sub-agent when openRunner is set", () => {
    render(
      <RunView {...base} openRunner={childRunner} onOpenSubRunner={() => {}} />,
    )
    // No need to click Expand tasks panel — focusing a sub auto-expands.
    expect(screen.getByText("child says hi")).toBeInTheDocument()
    cleanup()
  })

  it("forwards composer input via onSend", () => {
    let sent: { text: string } | undefined
    render(
      <RunView
        {...base}
        onSend={(t) => {
          sent = t
        }}
      />,
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "next" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(sent?.text).toBe("next")
    cleanup()
  })

  it("disables the composer when inert (replay)", () => {
    render(<RunView {...base} inert />)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    cleanup()
  })

  it("forwards onInterrupt to the composer stop button when busy", () => {
    let interrupted = 0
    render(
      <RunView
        {...base}
        busy
        onInterrupt={() => {
          interrupted += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }))
    expect(interrupted).toBe(1)
    cleanup()
  })

  it("shows the Thinking… elapsed label when busy and elapsedSeconds is provided", () => {
    render(<RunView {...base} busy elapsedSeconds={5} />)
    expect(screen.getByText(/Thinking.*5s/i)).toBeInTheDocument()
    cleanup()
  })

  it("shows only the typing dots (no elapsed label) when busy but elapsedSeconds is not provided", () => {
    render(<RunView {...base} busy />)
    expect(screen.queryByText(/Thinking/i)).toBeNull()
    // The typing indicator itself is present (role=status)
    expect(screen.getByRole("status")).toBeInTheDocument()
    cleanup()
  })

  it("renders the mode selector pill and fires onModeChange when a mode is picked", () => {
    const rootWithModes = {
      ...rootRunner,
      supportedModes: ["manual", "plan"] as const,
    }
    let picked: string | undefined
    render(
      <RunView
        {...base}
        root={rootWithModes}
        mode="manual"
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

  it("renders the model selector pill and fires onModelChange when a model is picked", () => {
    const models = [
      { id: "mdl_default", providerId: "p1", providerModel: "sonnet" },
      { id: "mdl_fast", providerId: "p1", providerModel: "haiku" },
    ] as unknown as readonly ModelRoute[]
    let picked: string | undefined
    render(
      <RunView
        {...base}
        model=""
        models={models}
        providerNames={{ p1: "Anthropic" }}
        onModelChange={(m) => {
          picked = m
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /default/i }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Anthropic \/ haiku/i }),
    )
    expect(picked).toBe("mdl_fast")
    cleanup()
  })

  it("shows the collapsed rail strip even when the root has no task list and no sub is open", () => {
    render(<RunView {...base} />)
    expect(
      screen.getByRole("button", { name: "Expand tasks panel" }),
    ).toBeInTheDocument()
    // No expanded Tasks tab while collapsed.
    expect(screen.queryByRole("tab", { name: "Tasks" })).toBeNull()
    cleanup()
  })

  it("shows the task rail when the root has a todo call", () => {
    const rid = RunnerIdSchema.parse("run_root")
    const withTasks = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c1",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "First task",
                activeForm: "Doing first",
                status: "pending",
              },
            ],
          },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const runner = withTasks.runners.get(rid)
    if (runner === undefined) throw new Error("missing runner")

    render(<RunView {...base} root={runner} runners={withTasks.runners} />)
    fireEvent.click(screen.getByRole("button", { name: "Expand tasks panel" }))
    expect(screen.getByText("First task")).toBeInTheDocument()
    cleanup()
  })

  it("collapses the rail and expands it again via the controls", () => {
    const rid = RunnerIdSchema.parse("run_root")
    const withTasks = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c1",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "First task",
                activeForm: "Doing first",
                status: "pending",
              },
            ],
          },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const runner = withTasks.runners.get(rid)
    if (runner === undefined) throw new Error("missing runner")

    render(<RunView {...base} root={runner} runners={withTasks.runners} />)
    // Starts collapsed: expand first.
    fireEvent.click(screen.getByRole("button", { name: "Expand tasks panel" }))
    expect(screen.getByText("First task")).toBeInTheDocument()

    // The expanded header has its own collapse button now; clicking it
    // collapses the rail.
    const railHeaderCollapse = document.querySelector(".lk-side-rail__collapse")
    if (railHeaderCollapse === null)
      throw new Error("missing rail header collapse")
    fireEvent.click(railHeaderCollapse)
    expect(screen.queryByText("First task")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Expand tasks panel" }))
    expect(screen.getByText("First task")).toBeInTheDocument()
    cleanup()
  })

  it("shows the segmented Tasks/Agents header when a sub-runner is open", () => {
    const rid = RunnerIdSchema.parse("run_root2")
    const cid = RunnerIdSchema.parse("run_child2")
    const st = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c2",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "Root task A",
                activeForm: "Doing root",
                status: "pending",
              },
            ],
          },
        },
        {
          type: "runner-started",
          runnerId: cid,
          parentRunnerId: rid,
          title: "child-sub",
        },
        {
          type: "text-delta",
          runnerId: cid,
          messageId: "m3",
          text: "child working",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const rootRunner2 = st.runners.get(rid)
    const childRunner2 = st.runners.get(cid)
    if (rootRunner2 === undefined || childRunner2 === undefined)
      throw new Error("missing runners")

    render(
      <RunView
        {...base}
        root={rootRunner2}
        runners={st.runners}
        openRunner={childRunner2}
      />,
    )
    expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument()
    expect(screen.getByText("child working")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Tasks" })).toBeDisabled()
    cleanup()
  })

  it("shows the focused sub-runner's own tasks under the Tasks tab", () => {
    const rid = RunnerIdSchema.parse("run_root3")
    const cid = RunnerIdSchema.parse("run_child3")
    const st = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c3",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "Root-only task",
                activeForm: "Doing root",
                status: "pending",
              },
            ],
          },
        },
        {
          type: "runner-started",
          runnerId: cid,
          parentRunnerId: rid,
          title: "child-sub2",
        },
        {
          type: "tool-call-started",
          runnerId: cid,
          callId: "c4",
          tool: "TodoWrite",
          input: {
            todos: [
              {
                content: "Sub-only task",
                activeForm: "Doing sub",
                status: "pending",
              },
            ],
          },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const rootRunner3 = st.runners.get(rid)
    const childRunner3 = st.runners.get(cid)
    if (rootRunner3 === undefined || childRunner3 === undefined)
      throw new Error("missing runners")

    render(
      <RunView
        {...base}
        root={rootRunner3}
        runners={st.runners}
        openRunner={childRunner3}
      />,
    )
    const tasksTab = screen.getByRole("tab", { name: "Tasks" })
    expect(tasksTab).not.toBeDisabled()
    fireEvent.click(tasksTab)
    expect(screen.getByText("Sub-only task")).toBeInTheDocument()
    expect(screen.queryByText("Root-only task")).toBeNull()
    cleanup()
  })

  it("threads onOpenLink into the message bubble so a link click opens it", () => {
    let opened: string | undefined
    const withLink = {
      ...base,
      onOpenLink: (url: string) => {
        opened = url
      },
    }
    // Build a root runner whose timeline contains a link message.
    const linkState: RunState = (
      [
        { type: "runner-started", runnerId: root },
        {
          type: "text-delta",
          runnerId: root,
          messageId: "m9",
          text: "[docs](https://docs.example.com)",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const linkRoot = linkState.runners.get(root)
    if (linkRoot === undefined) throw new Error("missing root")
    render(
      <RunView {...withLink} root={linkRoot} runners={linkState.runners} />,
    )
    fireEvent.click(screen.getByRole("link", { name: "docs" }))
    expect(opened).toBe("https://docs.example.com")
    cleanup()
  })

  it("threads onOpenLink into the sub-runner pane so a link click there opens it", () => {
    let opened: string | undefined
    const rid = RunnerIdSchema.parse("run_root_link")
    const cid = RunnerIdSchema.parse("run_child_link")
    // The child runner's timeline carries the link; opening the sub pane
    // (openRunner=childRunner) renders it through SubRunnerPane.
    const st = (
      [
        { type: "runner-started", runnerId: rid },
        { type: "text-delta", runnerId: rid, messageId: "mr", text: "root" },
        {
          type: "runner-started",
          runnerId: cid,
          parentRunnerId: rid,
          title: "child-link",
        },
        {
          type: "text-delta",
          runnerId: cid,
          messageId: "mc",
          text: "[sub docs](https://sub.example.com)",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const rootRunnerLink = st.runners.get(rid)
    const childRunnerLink = st.runners.get(cid)
    if (rootRunnerLink === undefined || childRunnerLink === undefined)
      throw new Error("missing runners")
    render(
      <RunView
        {...base}
        root={rootRunnerLink}
        runners={st.runners}
        openRunner={childRunnerLink}
        onOpenLink={(url) => {
          opened = url
        }}
      />,
    )
    fireEvent.click(screen.getByRole("link", { name: "sub docs" }))
    expect(opened).toBe("https://sub.example.com")
    cleanup()
  })

  it("auto-expands the rail on sub-open and stays expanded after the sub closes", () => {
    const rid = RunnerIdSchema.parse("run_root4")
    const cid = RunnerIdSchema.parse("run_child4")
    const st = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "runner-started",
          runnerId: cid,
          parentRunnerId: rid,
          title: "child-sub3",
        },
        {
          type: "text-delta",
          runnerId: cid,
          messageId: "m4",
          text: "child content",
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const rootRunner4 = st.runners.get(rid)
    const childRunner4 = st.runners.get(cid)
    if (rootRunner4 === undefined || childRunner4 === undefined)
      throw new Error("missing runners")

    const { rerender } = render(
      <RunView
        {...base}
        root={rootRunner4}
        runners={st.runners}
        openRunner={childRunner4}
      />,
    )
    // With a sub open the rail auto-expands (no Expand tasks panel button).
    expect(
      screen.queryByRole("button", { name: "Expand tasks panel" }),
    ).toBeNull()
    expect(screen.getByText("child content")).toBeInTheDocument()

    rerender(<RunView {...base} root={rootRunner4} runners={st.runners} />)
    // Sub closed, no tasks: the rail stays expanded (the user's last manual
    // collapse wins; with no manual collapse it stays open from the auto-expand).
    expect(
      screen.queryByRole("button", { name: "Expand tasks panel" }),
    ).toBeNull()
    cleanup()
  })

  it("renders the terminal pane below the composer, not above it", () => {
    const terminal = {
      paneOpen: true,
      tabs: [] as const,
      activeTabId: null,
      paneHeightPx: 220,
      openPane: async () => {},
      closePane: () => {},
      newTab: async () => {},
      closeTab: () => {},
      resizeHeight: () => {},
      selectTab: () => {},
      mountTerminal: () => () => {},
    }
    render(<RunView {...base} terminal={terminal} />)
    const composer = document.querySelector(".lk-composer")
    const pane = document.querySelector(".lk-terminal-pane")
    if (composer === null) throw new Error("expected composer")
    if (pane === null) throw new Error("expected terminal pane")
    // The terminal pane must follow the composer in document order so it sits
    // below the input textbox, not above it.
    const followsComposer =
      composer.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(followsComposer).toBeTruthy()
    cleanup()
  })

  it("keeps the terminal pane mounted (hidden) when collapsed but tabs exist", () => {
    const terminal = {
      paneOpen: false,
      tabs: [
        { id: "t1", title: "Terminal", exitCode: null, closed: false },
      ] as const,
      activeTabId: "t1",
      paneHeightPx: 220,
      openPane: async () => {},
      closePane: () => {},
      newTab: async () => {},
      closeTab: () => {},
      resizeHeight: () => {},
      selectTab: () => {},
      mountTerminal: () => () => {},
    }
    render(<RunView {...base} terminal={terminal} />)
    // Collapsing must NOT unmount the pane (that would kill the PTYs); it stays
    // in the DOM but hidden so the running sessions survive.
    const pane = document.querySelector<HTMLElement>(".lk-terminal-pane")
    if (pane === null) throw new Error("expected terminal pane to stay mounted")
    expect(pane.hidden).toBe(true)
    cleanup()
  })

  it("does not render the terminal pane when collapsed with no tabs", () => {
    const terminal = {
      paneOpen: false,
      tabs: [] as const,
      activeTabId: null,
      paneHeightPx: 220,
      openPane: async () => {},
      closePane: () => {},
      newTab: async () => {},
      closeTab: () => {},
      resizeHeight: () => {},
      selectTab: () => {},
      mountTerminal: () => () => {},
    }
    render(<RunView {...base} terminal={terminal} />)
    expect(document.querySelector(".lk-terminal-pane")).toBeNull()
    cleanup()
  })
})

const rvRoot = "rnr_root" as RunnerId
const rvBase: RunnerState = { id: rvRoot, status: "running", items: [] }

it("forwards a failed pending send's Resend through RunView", () => {
  const calls: Array<{ clientSendId?: string; text: string }> = []
  render(
    <RunView
      root={rvBase}
      runners={new Map()}
      subBreadcrumb={["main", "sub"]}
      onOpenSubRunner={() => {}}
      onCloseSub={() => {}}
      onSend={() => {}}
      onDecide={() => {}}
      onAnswer={() => {}}
      pending={[{ clientSendId: "c1", text: "lost", status: "failed" }]}
      onResend={(e) => calls.push(e)}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Resend" }))
  expect(calls).toEqual([{ clientSendId: "c1", text: "lost" }])
})
