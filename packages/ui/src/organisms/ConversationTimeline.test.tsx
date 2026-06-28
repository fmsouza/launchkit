import { describe, expect, it } from "bun:test"
import {
  type CanonicalEvent,
  type RunState,
  initialRunState,
  reduce,
} from "@spectrum/agent-events"
import type { RunnerId, RunnerState } from "@spectrum/agent-events"
import { RunnerIdSchema } from "@spectrum/types"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ConversationTimeline } from "./ConversationTimeline"

const root = RunnerIdSchema.parse("run_root")
const child = RunnerIdSchema.parse("run_child")

const fold = (events: readonly CanonicalEvent[]): RunState =>
  events.reduce(reduce, initialRunState)

const baseEvents: readonly CanonicalEvent[] = [
  { type: "runner-started", runnerId: root },
  { type: "text-delta", runnerId: root, messageId: "m1", text: "Hello" },
  { type: "tool-call-started", runnerId: root, callId: "c1", tool: "Bash" },
  {
    type: "tool-call-finished",
    runnerId: root,
    callId: "c1",
    status: "ok",
    output: "done",
  },
  {
    type: "approval-requested",
    runnerId: root,
    requestId: "rq1",
    target: { kind: "command", detail: "rm -rf build" },
  },
]

describe("ConversationTimeline", () => {
  it("renders an assistant message from a text-delta", () => {
    const state = fold(baseEvents)
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(screen.getByText("Hello")).toBeInTheDocument()
    cleanup()
  })

  it("renders the message a turn error references in its error state", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "text-delta",
        runnerId: root,
        messageId: "m1",
        text: "API Error: 429 you have reached your session usage limit",
      },
      {
        type: "turn-finished",
        runnerId: root,
        error: {
          detail: "API Error: 429 you have reached your session usage limit",
          messageId: "m1",
        },
      },
    ])
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    const { container } = render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(
      container.querySelector('.lk-message-bubble[data-tone="error"]'),
    ).not.toBeNull()
    cleanup()
  })

  it("renders a tool call card for a finished tool call", () => {
    const state = fold(baseEvents)
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(screen.getByTestId("tool-call-c1")).toBeInTheDocument()
    cleanup()
  })

  it("renders an inline approval card and forwards a decision", () => {
    const state = fold(baseEvents)
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    let decided: string | undefined
    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={(rq, d) => {
          decided = `${rq}:${d}`
        }}
        onAnswer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(decided).toBe("rq1:allow")
    cleanup()
  })

  it("does not render todo tool-calls inline", () => {
    const rid = RunnerIdSchema.parse("run_root")
    const state = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c1",
          tool: "TodoWrite",
          input: {
            todos: [{ content: "A", activeForm: "Doing A", status: "pending" }],
          },
        },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c2",
          tool: "Bash",
          input: { command: "ls" },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const runner = state.runners.get(rid)
    if (runner === undefined) throw new Error("missing runner")

    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(screen.queryByText("TodoWrite")).toBeNull()
    expect(screen.getByText("Bash")).toBeInTheDocument()
    cleanup()
  })

  it("does not render TaskCreate/TaskUpdate/TaskList cards inline", () => {
    const rid = RunnerIdSchema.parse("run_root")
    const state = (
      [
        { type: "runner-started", runnerId: rid },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c1",
          tool: "TaskCreate",
          input: { subject: "Verify the rail" },
        },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c2",
          tool: "TaskUpdate",
          input: { taskId: "1", status: "completed" },
        },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c3",
          tool: "TaskList",
          input: {},
        },
        {
          type: "tool-call-started",
          runnerId: rid,
          callId: "c4",
          tool: "Bash",
          input: { command: "ls" },
        },
      ] satisfies readonly CanonicalEvent[]
    ).reduce(reduce, initialRunState)
    const runner = state.runners.get(rid)
    if (runner === undefined) throw new Error("missing runner")

    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    expect(screen.queryByText("TaskCreate")).toBeNull()
    expect(screen.queryByText("TaskUpdate")).toBeNull()
    expect(screen.queryByText("TaskList")).toBeNull()
    expect(screen.getByText("Bash")).toBeInTheDocument()
    cleanup()
  })

  it("renders a sub-runner card for a tool call that spawned a runner and forwards open", () => {
    const events: readonly CanonicalEvent[] = [
      { type: "runner-started", runnerId: root },
      { type: "tool-call-started", runnerId: root, callId: "c9", tool: "Task" },
      {
        type: "runner-started",
        runnerId: child,
        parentRunnerId: root,
        spawnedByCallId: "c9",
        title: "search docs",
      },
    ]
    const state = fold(events)
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    let opened: string | undefined
    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={(id) => {
          opened = id
        }}
        onDecide={() => {}}
        onAnswer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /search docs/ }))
    expect(opened).toBe(child)
    cleanup()
  })

  it("renders a question card and forwards the answer with requestId", () => {
    const state = fold([
      { type: "runner-started", runnerId: root },
      {
        type: "question-requested",
        runnerId: root,
        requestId: "qr1",
        prompt: {
          questions: [
            {
              question: "Pick one",
              header: "Choice",
              options: [{ label: "Alpha" }, { label: "Beta" }],
              multiSelect: false,
              allowFreeText: false,
            },
          ],
        },
      },
    ])
    const runner = state.runners.get(root)
    if (runner === undefined) throw new Error("no root runner")
    let answeredId: string | undefined
    let answeredVal: unknown
    render(
      <ConversationTimeline
        runner={runner}
        runners={state.runners}
        onOpenSubRunner={() => {}}
        onDecide={() => {}}
        onAnswer={(requestId, answer) => {
          answeredId = requestId
          answeredVal = answer
        }}
      />,
    )
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Alpha"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(answeredId).toBe("qr1")
    expect(answeredVal).toEqual({
      selections: [{ questionIndex: 0, labels: ["Alpha"] }],
    })
    cleanup()
  })
})

describe("ConversationTimeline pending sends", () => {
  const baseRunner: RunnerState = {
    id: RunnerIdSchema.parse("rnr_root"),
    status: "running",
    items: [],
  }

  const noop = {
    runners: new Map<RunnerId, RunnerState>(),
    onOpenSubRunner: () => {},
    onDecide: () => {},
    onAnswer: () => {},
  }

  it("renders a failed pending send with Resend/Cancel carrying the clientSendId", () => {
    const calls: Array<{ clientSendId?: string; text: string }> = []
    render(
      <ConversationTimeline
        runner={baseRunner}
        {...noop}
        pending={[
          { clientSendId: "c1", text: "lost prompt", status: "failed" },
        ]}
        onResend={(e) => calls.push(e)}
        onCancel={(e) => calls.push(e)}
      />,
    )
    expect(screen.getByText("lost prompt")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Resend" }))
    expect(calls).toEqual([{ clientSendId: "c1", text: "lost prompt" }])
    cleanup()
  })
})
