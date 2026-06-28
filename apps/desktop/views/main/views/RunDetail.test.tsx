import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import type { RunnerOutbound } from "@spectrum/agent-driver"
import type { CanonicalEvent, StoredEvent } from "@spectrum/agent-events"
import {
  type HarnessId,
  type ModelId,
  type ModelRoute,
  type SessionId,
  SessionIdSchema,
} from "@spectrum/types"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import type { RunnerClient } from "../runner/runnerClient"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { RunDetail, SEND_ACK_TIMEOUT_MS } from "./RunDetail"

const id = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")

// A fake runner client: records attach + commands, lets the test push frames.
const makeFakeRunner = (): RunnerClient & {
  readonly attached: SessionId[]
  readonly sends: string[]
  readonly setModes: Array<{ id: SessionId; mode: string }>
  readonly setModels: Array<{ id: SessionId; modelId: ModelId | null }>
  push: (event: StoredEvent) => void
  connectionLost: () => void
} => {
  let listener: ((event: StoredEvent) => void) | undefined
  const connectionLostListeners = new Set<() => void>()
  const attached: SessionId[] = []
  const sends: string[] = []
  const setModes: Array<{ id: SessionId; mode: string }> = []
  const setModels: Array<{ id: SessionId; modelId: ModelId | null }> = []
  return {
    attached,
    sends,
    setModes,
    setModels,
    attach: (sid) => attached.push(sid),
    send: (_sid, text) => sends.push(text),
    approve: () => {},
    interrupt: () => {},
    setMode: (sid, mode) => setModes.push({ id: sid, mode }),
    setModel: (sid, modelId) => setModels.push({ id: sid, modelId }),
    dispatch: (_m: RunnerOutbound) => {},
    onEvent: (_sid, cb) => {
      listener = cb
    },
    onAny: () => () => {},
    onSessionRenamed: () => () => {},
    onResumeToken: () => () => {},
    onConnectionLost: (cb) => {
      connectionLostListeners.add(cb)
      return () => {
        connectionLostListeners.delete(cb)
      }
    },
    connectionLost: () => {
      for (const cb of connectionLostListeners) cb()
    },
    push: (event) => listener?.(event),
  }
}

const stored = (seq: number, event: CanonicalEvent): StoredEvent => ({
  seq,
  sessionId: id,
  ts: "2026-06-08T10:00:00.000Z",
  event,
})

describe("RunDetail (live)", () => {
  beforeEach(() => {
    // Clear localStorage so outbox hydration never loads entries from prior tests.
    globalThis.localStorage?.clear()
  })

  it("attaches the runner socket on mount", () => {
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    expect(runner.attached).toEqual([id])
    cleanup()
  })

  it("renders reduced events pushed over the socket", async () => {
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    runner.push(
      stored(1, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "m1",
        text: "Hello from the agent",
      }),
    )
    await waitFor(() =>
      expect(screen.getByText("Hello from the agent")).toBeInTheDocument(),
    )
    cleanup()
  })

  it("forwards a composer turn over the runner socket", async () => {
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(runner.sends).toEqual(["go"])
    cleanup()
  })

  it("shows stop button while busy and clicking it calls interrupt", async () => {
    const interrupted: SessionId[] = []
    const base = makeFakeRunner()
    const runner: typeof base = {
      ...base,
      interrupt: (sid) => interrupted.push(sid),
    }
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    // A user text-delta sets busy=true in the runViewStore
    runner.push(
      stored(1, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "m1",
        text: "Hello",
        role: "user",
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop run" }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }))
    expect(interrupted).toEqual([id])
    cleanup()
  })

  it("renders the mode selector pill and calls runnerClient.setMode on pick", async () => {
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, {
        type: "runner-started",
        runnerId: "run_root" as never,
        supportedModes: ["manual", "bypass"],
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /manual approval/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /manual approval/i }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /bypass permissions/i }),
    )
    expect(runner.setModes).toEqual([{ id, mode: "bypass" }])
    cleanup()
  })

  it("persists the picked mode per-harness via updateHarnessPrefs", async () => {
    const runner = makeFakeRunner()
    const prefsCalls: Array<{ harnessId: string; mode?: string }> = []
    const client = createFakeIpcClient({
      updateHarnessPrefs: async (p: { harnessId: string; mode?: string }) => {
        prefsCalls.push(p)
        return { ok: true, value: null }
      },
    })
    renderWithProviders(
      <RunDetail
        mode="live"
        sessionId={id}
        runnerClient={runner}
        harnessId={"claude" as HarnessId}
      />,
      client,
    )
    runner.push(
      stored(0, {
        type: "runner-started",
        runnerId: "run_root" as never,
        supportedModes: ["manual", "bypass"],
      }),
    )
    await waitFor(() =>
      screen.getByRole("button", { name: /manual approval/i }),
    )
    fireEvent.click(screen.getByRole("button", { name: /manual approval/i }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /bypass permissions/i }),
    )
    expect(prefsCalls).toEqual([{ harnessId: "claude", mode: "bypass" }])
    expect(runner.setModes).toEqual([{ id, mode: "bypass" }])
    cleanup()
  })

  it("forwards the default pick (empty string) as a null modelId over the socket", async () => {
    const runner = makeFakeRunner()
    const models = [
      { id: "mdl_a", providerId: "p1", providerModel: "sonnet" },
    ] as readonly ModelRoute[]
    const providerNames: Readonly<Record<string, string>> = { p1: "Anthropic" }
    renderWithProviders(
      <RunDetail
        mode="live"
        sessionId={id}
        runnerClient={runner}
        models={models}
        providerNames={providerNames}
      />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, {
        type: "runner-started",
        runnerId: "run_root" as never,
        model: "mdl_a",
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(
      screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
    )
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^default$/i }))
    expect(runner.setModels).toEqual([{ id, modelId: null }])
    cleanup()
  })

  it("renders the model selector pill and calls runnerClient.setModel on pick", async () => {
    const runner = makeFakeRunner()
    const models = [
      { id: "mdl_a", providerId: "p1", providerModel: "sonnet" },
      { id: "mdl_b", providerId: "p1", providerModel: "haiku" },
    ] as readonly ModelRoute[]
    const providerNames: Readonly<Record<string, string>> = { p1: "Anthropic" }
    renderWithProviders(
      <RunDetail
        mode="live"
        sessionId={id}
        runnerClient={runner}
        models={models}
        providerNames={providerNames}
      />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, {
        type: "runner-started",
        runnerId: "run_root" as never,
        model: "mdl_a",
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(
      screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
    )
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Anthropic \/ haiku/i }),
    )
    expect(runner.setModels).toEqual([{ id, modelId: "mdl_b" }])
    cleanup()
  })

  it("persists the picked model per-harness via updateHarnessPrefs", async () => {
    const runner = makeFakeRunner()
    const models = [
      { id: "mdl_a", providerId: "p1", providerModel: "sonnet" },
      { id: "mdl_b", providerId: "p1", providerModel: "haiku" },
    ] as readonly ModelRoute[]
    const providerNames: Readonly<Record<string, string>> = { p1: "Anthropic" }
    const prefsCalls: Array<{
      harnessId: string
      mode?: string
      modelId?: string
    }> = []
    const client = createFakeIpcClient({
      updateHarnessPrefs: async (p: {
        harnessId: string
        mode?: string
        modelId?: string
      }) => {
        prefsCalls.push(p)
        return { ok: true, value: null }
      },
    })
    renderWithProviders(
      <RunDetail
        mode="live"
        sessionId={id}
        runnerClient={runner}
        harnessId={"claude" as HarnessId}
        models={models}
        providerNames={providerNames}
      />,
      client,
    )
    runner.push(
      stored(0, {
        type: "runner-started",
        runnerId: "run_root" as never,
        model: "mdl_a",
      }),
    )
    await waitFor(() =>
      screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
    )
    fireEvent.click(
      screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
    )
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Anthropic \/ haiku/i }),
    )
    expect(prefsCalls).toEqual([{ harnessId: "claude", modelId: "mdl_b" }])
    expect(runner.setModels).toEqual([{ id, modelId: "mdl_b" }])
    cleanup()
  })

  it("re-sends the last user prompt over the runner socket when Resend is clicked", async () => {
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    runner.push(
      stored(1, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "u1",
        text: "fix the bug",
        role: "user",
      }),
    )
    runner.push(
      stored(2, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "a1",
        text: "Error: rate limited",
      }),
    )
    runner.push(
      stored(3, {
        type: "turn-finished",
        runnerId: "run_root" as never,
        error: { detail: "Error: rate limited", messageId: "a1" },
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /resend/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /resend/i }))
    expect(runner.sends).toEqual(["fix the bug"])
    cleanup()
  })

  it("does NOT attach the runner socket when skipAttach is true (resumed session)", () => {
    // The page sets skipAttach=true for a session it just resumed — the
    // manager replays the backlog itself, so the webview's run-attach would
    // double-replay. LiveRunDetail must honor the flag and skip attach.
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} skipAttach />,
      createFakeIpcClient({}),
    )
    expect(runner.attached).toEqual([])
    cleanup()
  })

  it("applies each replayed event exactly once even if the socket replays the backlog twice (double-replay safety)", async () => {
    // Mirrors the resume flow at the RunDetail level: the manager's
    // events.read replay can be followed by a redundant run-attach, so the
    // same stored event can land on `onEvent` twice. The reducer must drop
    // duplicates so the timeline shows the conversation exactly once.
    const runner = makeFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} skipAttach />,
      createFakeIpcClient({}),
    )
    const events: StoredEvent[] = [
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
      stored(1, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "m1",
        text: "hello",
      }),
      stored(2, {
        type: "tool-call-started",
        runnerId: "run_root" as never,
        callId: "c1",
        tool: "Bash",
      }),
      stored(3, {
        type: "approval-requested",
        runnerId: "run_root" as never,
        requestId: "req1",
        target: { kind: "command", detail: "ls" },
      }),
    ]
    // First delivery (manager replay)
    for (const e of events) runner.push(e)
    // Second delivery (hypothetical redundant run-attach)
    for (const e of events) runner.push(e)
    // The text-delta text must NOT be doubled; the tool call and approval
    // must each appear exactly once. (No DOM text node to assert directly
    // for tool/approval; the reducer test covers the data invariant. Here
    // we assert the user-visible text is not concatenated.)
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument())
    expect(screen.queryByText("hellohello")).not.toBeInTheDocument()
    cleanup()
  })
})

describe("RunDetail (replay)", () => {
  it("folds getRunEvents into a read-only timeline with a disabled composer", async () => {
    const runner = makeFakeRunner()
    const client = createFakeIpcClient({
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            stored(0, {
              type: "runner-started",
              runnerId: "run_root" as never,
            }),
            stored(1, {
              type: "text-delta",
              runnerId: "run_root" as never,
              messageId: "m1",
              text: "Recorded reply",
            }),
          ],
        },
      }),
    })
    renderWithProviders(
      <RunDetail mode="replay" sessionId={id} runnerClient={runner} />,
      client,
    )
    await waitFor(() =>
      expect(screen.getByText("Recorded reply")).toBeInTheDocument(),
    )
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    expect(runner.attached).toEqual([]) // replay never attaches the socket
    cleanup()
  })

  it("enables the composer in replay mode so a send triggers onResumeSend", async () => {
    const runner = makeFakeRunner()
    const resumeSends: { id: SessionId; text: string }[] = []
    const onResumeSend = (text: string): void => {
      resumeSends.push({ id, text })
    }
    const client = createFakeIpcClient({
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            stored(0, {
              type: "runner-started",
              runnerId: "run_root" as never,
            }),
            stored(1, {
              type: "text-delta",
              runnerId: "run_root" as never,
              messageId: "m1",
              text: "Recorded reply",
            }),
          ],
        },
      }),
    })
    renderWithProviders(
      <RunDetail
        mode="replay"
        sessionId={id}
        runnerClient={runner}
        onResumeSend={onResumeSend}
      />,
      client,
    )
    await waitFor(() =>
      expect(screen.getByText("Recorded reply")).toBeInTheDocument(),
    )
    // Type into the composer; the send button enables (proving the composer isn't inert).
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "continue from here" },
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toBeDisabled(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(resumeSends).toEqual([{ id, text: "continue from here" }])
    // Replay still never attached the socket — the manager replays the backlog.
    expect(runner.attached).toEqual([])
    cleanup()
  })

  it("renders the mode and model dropdowns in replay", async () => {
    // Regression guard: the bug was that ended-session replay omitted the
    // mode/model props on RunView, so the Composer hid both dropdowns.
    // Both must render in replay (Composer renders them when supportedModes
    // / models + onChange are present).
    const runner = makeFakeRunner()
    const models = [
      { id: "mdl_recorded", providerId: "p1", providerModel: "sonnet" },
    ] as readonly ModelRoute[]
    const providerNames: Readonly<Record<string, string>> = { p1: "Anthropic" }
    const client = createFakeIpcClient({
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            stored(0, {
              type: "runner-started",
              runnerId: "run_root" as never,
              permissionMode: "plan",
              model: "mdl_recorded",
              supportedModes: ["manual", "plan", "auto-edits", "bypass"],
            }),
            stored(1, {
              type: "text-delta",
              runnerId: "run_root" as never,
              messageId: "m1",
              text: "Recorded reply",
            }),
          ],
        },
      }),
    })
    renderWithProviders(
      <RunDetail
        mode="replay"
        sessionId={id}
        runnerClient={runner}
        models={models}
        providerNames={providerNames}
      />,
      client,
    )
    // ModeSelector pill button (no role="combobox" in markup — query by label).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /plan mode/i }),
      ).toBeInTheDocument(),
    )
    // ModelSelector pill button.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Anthropic \/ sonnet/i }),
      ).toBeInTheDocument(),
    )
    cleanup()
  })

  it("seeds the dropdowns from the folded root runner-started in replay", async () => {
    // The reducer does NOT project `permissionMode`/`model` from runner-started
    // into RunState (those fields live only on the event envelope), so replay
    // must seed the composer store from the folded event itself. With
    // permissionMode: "plan" on the root runner-started, the mode pill must
    // display the plan-mode label.
    const runner = makeFakeRunner()
    const client = createFakeIpcClient({
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            stored(0, {
              type: "runner-started",
              runnerId: "run_root" as never,
              permissionMode: "plan",
              model: "mdl_recorded",
              supportedModes: ["manual", "plan"],
            }),
          ],
        },
      }),
    })
    renderWithProviders(
      <RunDetail mode="replay" sessionId={id} runnerClient={runner} />,
      client,
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /plan mode/i }),
      ).toBeInTheDocument(),
    )
    cleanup()
  })

  it("changing the model in replay updates the store, not a live socket", async () => {
    // Replay has no live socket — picking a model in the replay composer must
    // persist via the harness pref (when harnessId is forwarded) but never
    // reach the runnerClient.setModel method on the live socket.
    const setModelSpy = mock(() => {})
    const base = makeFakeRunner()
    const runner: typeof base = {
      ...base,
      setModel: (sid, modelId) => {
        setModelSpy(sid, modelId)
        base.setModel(sid, modelId)
      },
    }
    const models = [
      { id: "mdl_recorded", providerId: "p1", providerModel: "sonnet" },
      { id: "mdl_new", providerId: "p1", providerModel: "haiku" },
    ] as readonly ModelRoute[]
    const providerNames: Readonly<Record<string, string>> = { p1: "Anthropic" }
    const prefsCalls: Array<{
      harnessId: string
      mode?: string
      modelId?: string
    }> = []
    const client = createFakeIpcClient({
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            stored(0, {
              type: "runner-started",
              runnerId: "run_root" as never,
              model: "mdl_recorded",
              supportedModes: ["manual", "plan"],
            }),
          ],
        },
      }),
      updateHarnessPrefs: async (p: {
        harnessId: string
        mode?: string
        modelId?: string
      }) => {
        prefsCalls.push(p)
        return { ok: true, value: null }
      },
    })
    renderWithProviders(
      <RunDetail
        mode="replay"
        sessionId={id}
        runnerClient={runner}
        harnessId={"claude" as HarnessId}
        models={models}
        providerNames={providerNames}
        onResumeSend={() => {}}
      />,
      client,
    )
    const modelPill = await screen.findByRole("button", {
      name: /Anthropic \/ sonnet/i,
    })
    fireEvent.click(modelPill)
    const haiku = await screen.findByRole("menuitemradio", {
      name: /Anthropic \/ haiku/i,
    })
    fireEvent.click(haiku)
    // Replay has no live forward: runnerClient.setModel is NEVER called.
    expect(setModelSpy).not.toHaveBeenCalled()
    // The harness pref IS still persisted so the next live session opens with
    // the user's pick.
    await waitFor(() =>
      expect(prefsCalls).toEqual([{ harnessId: "claude", modelId: "mdl_new" }]),
    )
    cleanup()
  })
})

describe("RunDetail (outbox / optimistic send)", () => {
  beforeEach(() => {
    // Clear localStorage so outbox hydration never loads entries from prior tests.
    globalThis.localStorage?.clear()
  })

  // A fake runner that captures the full 3-arg send signature for clientSendId inspection.
  const makeRichFakeRunner = (): RunnerClient & {
    readonly attached: SessionId[]
    readonly richSends: Array<{
      id: SessionId
      text: string
      clientSendId: string | undefined
    }>
    push: (event: StoredEvent) => void
    connectionLost: () => void
  } => {
    let listener: ((event: StoredEvent) => void) | undefined
    const connectionLostListeners = new Set<() => void>()
    const attached: SessionId[] = []
    const richSends: Array<{
      id: SessionId
      text: string
      clientSendId: string | undefined
    }> = []
    return {
      attached,
      richSends,
      attach: (sid) => attached.push(sid),
      send: (sid, text, clientSendId) =>
        richSends.push({ id: sid, text, clientSendId }),
      approve: () => {},
      interrupt: () => {},
      setMode: () => {},
      setModel: () => {},
      dispatch: (_m: RunnerOutbound) => {},
      onEvent: (_sid, cb) => {
        listener = cb
      },
      onAny: () => () => {},
      onSessionRenamed: () => () => {},
      onResumeToken: () => () => {},
      onConnectionLost: (cb) => {
        connectionLostListeners.add(cb)
        return () => {
          connectionLostListeners.delete(cb)
        }
      },
      connectionLost: () => {
        for (const cb of connectionLostListeners) cb()
      },
      push: (event) => listener?.(event),
    }
  }

  it("enqueues an optimistic sending bubble and sends with a clientSendId", async () => {
    const runner = makeRichFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    // Emit runner-started so the composer becomes visible.
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))

    // Type and submit.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    // send() was called once with a uuid clientSendId.
    expect(runner.richSends).toHaveLength(1)
    expect(runner.richSends[0]?.text).toBe("hello")
    expect(runner.richSends[0]?.id).toBe(id)
    expect(typeof runner.richSends[0]?.clientSendId).toBe("string")
    expect(runner.richSends[0]?.clientSendId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    // The optimistic bubble is in the DOM with data-status="sending".
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-status="sending"]')?.textContent,
    ).toContain("hello")

    cleanup()
  })

  it("marks a send as failed when the connection is lost", async () => {
    const runner = makeRichFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))

    // Send a message.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    // Wait for the sending bubble.
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )

    // Trigger connection loss.
    runner.connectionLost()

    // The bubble should flip to data-status="failed" with a Resend button.
    await waitFor(() => {
      expect(document.querySelector('[data-status="failed"]')).not.toBeNull()
      expect(
        screen.getByRole("button", { name: /resend/i }),
      ).toBeInTheDocument()
    })

    cleanup()
  })

  it("marks a send as failed after the ack timeout elapses", async () => {
    jest.useFakeTimers()
    try {
      const runner = makeRichFakeRunner()
      renderWithProviders(
        <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
        createFakeIpcClient({}),
      )
      runner.push(
        stored(0, { type: "runner-started", runnerId: "run_root" as never }),
      )
      await waitFor(() => screen.getByRole("button", { name: "Send message" }))

      // Send a message.
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hello" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Send message" }))

      // Wait for the sending bubble.
      await waitFor(() =>
        expect(
          document.querySelector('[data-status="sending"]'),
        ).not.toBeNull(),
      )

      // Advance time past the ack timeout — no echo delivered.
      jest.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 1)

      // The bubble should flip to data-status="failed".
      await waitFor(() => {
        expect(document.querySelector('[data-status="failed"]')).not.toBeNull()
      })
    } finally {
      jest.useRealTimers()
      cleanup()
    }
  })

  it("resend re-dispatches a failed send with a new clientSendId", async () => {
    const runner = makeRichFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))

    // Send "hello".
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    // Wait for the sending bubble.
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )

    const firstClientSendId = runner.richSends[0]?.clientSendId as string

    // Trigger connection loss to flip it to failed.
    runner.connectionLost()

    await waitFor(() =>
      expect(document.querySelector('[data-status="failed"]')).not.toBeNull(),
    )

    // Click Resend.
    fireEvent.click(screen.getByRole("button", { name: /resend/i }))

    // A second send must have been dispatched with a DIFFERENT clientSendId.
    await waitFor(() => expect(runner.richSends).toHaveLength(2))
    expect(runner.richSends[1]?.text).toBe("hello")
    expect(runner.richSends[1]?.clientSendId).not.toBe(firstClientSendId)
    expect(runner.richSends[1]?.clientSendId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    // A sending bubble must be present again.
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )

    cleanup()
  })

  it("cancel removes the failed bubble and restores the text to the composer", async () => {
    const runner = makeRichFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))

    // Send "hello".
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    // Wait for the sending bubble.
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )

    // Trigger connection loss.
    runner.connectionLost()

    await waitFor(() =>
      expect(document.querySelector('[data-status="failed"]')).not.toBeNull(),
    )

    // Click Cancel.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    // No "hello" bubble should remain (failed or otherwise).
    await waitFor(() => {
      expect(document.querySelector('[data-status="failed"]')).toBeNull()
      expect(document.querySelector('[data-status="sending"]')).toBeNull()
    })

    // The composer textarea must be pre-filled with "hello".
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea.value).toBe("hello")

    cleanup()
  })

  it("removes the optimistic bubble once the echo with the same clientSendId arrives", async () => {
    const runner = makeRichFakeRunner()
    renderWithProviders(
      <RunDetail mode="live" sessionId={id} runnerClient={runner} />,
      createFakeIpcClient({}),
    )
    // Start the runner.
    runner.push(
      stored(0, { type: "runner-started", runnerId: "run_root" as never }),
    )
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))

    // Send a message to enqueue an optimistic bubble.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    // Wait for the sending bubble to appear.
    await waitFor(() =>
      expect(document.querySelector('[data-status="sending"]')).not.toBeNull(),
    )

    // Read back the generated clientSendId from the captured send call.
    const clientSendId = runner.richSends[0]?.clientSendId as string

    // Deliver the backend echo: a text-delta with role:"user" and the same clientSendId.
    runner.push(
      stored(1, {
        type: "text-delta",
        runnerId: "run_root" as never,
        messageId: "echo1",
        text: "hello",
        role: "user",
        clientSendId,
      }),
    )

    // The sending bubble should be reconciled away — no data-status="sending" elements,
    // and exactly ONE MessageBubble with data-role="user" containing "hello".
    await waitFor(() => {
      expect(document.querySelector('[data-status="sending"]')).toBeNull()
      // Count distinct MessageBubble containers (data-role="user" divs) that contain "hello".
      const userBubbles = Array.from(
        document.querySelectorAll('[data-role="user"]'),
      ).filter((el) => el.textContent?.includes("hello"))
      expect(userBubbles).toHaveLength(1)
    })

    cleanup()
  })
})
