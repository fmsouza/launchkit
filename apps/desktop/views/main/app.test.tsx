import { describe, expect, it } from "bun:test"
import type { RunnerOutbound } from "@spectrum/agent-driver"
import type { StoredEvent } from "@spectrum/agent-events"
import type { SessionId } from "@spectrum/types"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { App } from "./app"
import { type RunnerClient, createRunnerClient } from "./runner/runnerClient"
import { createFakeIpcClient } from "./test/fake-client"
import { createUpdateClient } from "./update/updateClient"

/**
 * Build a real `runner-started` frame for session `id`. A PARENTLESS start records the session's
 * ROOT runner; a start WITH `parentRunnerId` is a sub-agent and does not. The toast effect tracks
 * roots from these frames so it can tell a root finish from a sub-agent finish.
 */
const startedFrame = (
  id: SessionId,
  runnerId: string,
  parentRunnerId?: string,
): RunnerOutbound => {
  const event: StoredEvent = {
    seq: 1,
    sessionId: id,
    ts: "2026-06-16T10:00:00.000Z",
    event: {
      type: "runner-started",
      runnerId: runnerId as never,
      ...(parentRunnerId !== undefined
        ? { parentRunnerId: parentRunnerId as never }
        : {}),
    },
  }
  return { type: "runner-event", id, event }
}

/** The root runnerId every `finishedFrame` reports finishing — matches `rootStart` below. */
const ROOT_RUNNER = "run_root"

/** A parentless `runner-started` whose runnerId == the one `finishedFrame` finishes. */
const rootStart = (id: SessionId): RunnerOutbound =>
  startedFrame(id, ROOT_RUNNER)

/**
 * Build a real `runner-finished` frame for session `id` (for the ROOT runner). Using the REAL
 * `createRunnerClient` (below) means `dispatch(frame)` flows through `onAny` into the App's toast
 * effect — exercising the actual feature path end-to-end. The finishing runnerId matches the root
 * established by `rootStart(id)`, which tests must dispatch first (fail-closed gating).
 */
const finishedFrame = (
  id: SessionId,
  status: "completed" | "errored" | "interrupted",
): RunnerOutbound => {
  const event: StoredEvent = {
    seq: 2,
    sessionId: id,
    ts: "2026-06-16T10:00:00.000Z",
    event: {
      type: "runner-finished",
      runnerId: ROOT_RUNNER as never,
      status,
      ...(status === "errored" ? { error: "boom" } : {}),
    },
  }
  return { type: "runner-event", id, event }
}

/** A `runner-finished` for an ARBITRARY runnerId (e.g. a sub-agent), used to drive sub-vs-root cases. */
const finishedFrame2 = (
  id: SessionId,
  runnerId: string,
  status: "completed" | "errored" | "interrupted",
): RunnerOutbound => {
  const event: StoredEvent = {
    seq: 3,
    sessionId: id,
    ts: "2026-06-16T10:00:00.000Z",
    event: {
      type: "runner-finished",
      runnerId: runnerId as never,
      status,
      ...(status === "errored" ? { error: "boom" } : {}),
    },
  }
  return { type: "runner-event", id, event }
}

const fakeRunnerClient: RunnerClient = {
  attach: () => {},
  send: () => {},
  approve: () => {},
  interrupt: () => {},
  dispatch: () => {},
  onEvent: () => {},
  onAny: () => () => {},
  onSessionRenamed: () => () => {},
  onResumeToken: () => () => {},
} as unknown as RunnerClient

const fakeUpdateClient = createUpdateClient()

const baseStubs = {
  getSessions: async () => ({ ok: true as const, value: [] }),
  getHarnesses: async () => ({ ok: true as const, value: [] }),
  getProxyStatus: async () => ({
    ok: true as const,
    value: { running: false, port: 4000 },
  }),
  getModels: async () => ({ ok: true as const, value: [] }),
  getProviders: async () => ({ ok: true as const, value: [] }),
  getProjects: async () => ({ ok: true as const, value: [] }),
  setCollapsedProjects: async () => ({ ok: true as const, value: null }),
}

describe("App view model", () => {
  it("mounts the toast stack in the app shell", async () => {
    const client = createFakeIpcClient(baseStubs)
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
      />,
    )
    // The notifications engine's ToastContainer is mounted in the shell; its
    // (initially empty) stack container is always present.
    await waitFor(() =>
      expect(container.querySelector(".lk-toast-stack")).not.toBeNull(),
    )
  })

  it("defaults to the sessions view and writes #sessions to the hash", async () => {
    window.location.hash = ""
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
  })

  it("parses #settings/providers into the settings view on the matching section", async () => {
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="settings/providers"
      />,
    )
    await waitFor(() =>
      expect(window.location.hash).toBe("#settings/providers"),
    )
  })

  it("maps the retired #dashboard hash to the sessions view", async () => {
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="dashboard"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
  })

  it("renders the AppShell in sessions mode by default", async () => {
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
  })

  it("opens the new-session modal and launches via launchHarness from the sessions header", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      launchHarness: async () => ({
        ok: true as const,
        value: { sessionId: "s_new" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Open the modal via SessionList's "+ New session" button (Phase 6 / U.7).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /new session/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /new session/i }))
    // NewSessionModal (Phase 6 / U.11) submit control is the "Launch" button;
    // harness/model default to the first option.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /launch/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /launch/i }))
    await waitFor(() => expect(client.calls.launchHarness.length).toBe(1))
    expect(client.calls.launchHarness[0]).toMatchObject({ id: "claude" })
    await waitFor(() => expect(window.location.hash).toBe("#sessions/s_new"))
  })

  it("keeps the modal open and shows the error when launchHarness fails (Bug 1)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      launchHarness: async () => ({
        ok: false as const,
        error: { kind: "handler-failed" as const, detail: "boom: no key" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    fireEvent.click(await screen.findByRole("button", { name: /launch/i }))
    await waitFor(() => expect(client.calls.launchHarness.length).toBe(1))
    // The error surfaces in the modal's alert ...
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/boom: no key/i),
    )
    // ... the modal stays open (Launch still on screen) and the view is NOT
    // switched to the (nonexistent) session.
    expect(screen.getByRole("button", { name: /launch/i })).toBeInTheDocument()
    expect(window.location.hash).not.toContain("/")
  })

  it("omits name from launchHarness so the RunManager auto-derives it at runtime (Fix #3)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      launchHarness: async () => ({
        ok: true as const,
        value: { sessionId: "s_new" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    // Name field is removed (Fix #3); modal omits name so RunManager auto-derives it
    fireEvent.click(await screen.findByRole("button", { name: /launch/i }))
    await waitFor(() => expect(client.calls.launchHarness.length).toBe(1))
    const params = client.calls.launchHarness[0] as Record<string, unknown>
    expect("name" in params).toBe(false)
    expect("cwd" in params).toBe(false)
  })

  it("refetches projects after a successful launch", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      launchHarness: async () => ({
        ok: true as const,
        value: { sessionId: "s_new" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // On mount, getProjects is called at least once.
    await waitFor(() =>
      expect(client.calls.getProjects.length).toBeGreaterThan(0),
    )
    const projectsCountBefore = client.calls.getProjects.length
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    fireEvent.click(await screen.findByRole("button", { name: /launch/i }))
    await waitFor(() => expect(client.calls.launchHarness.length).toBe(1))
    // After a successful launch, projects are invalidated and refetched.
    await waitFor(() =>
      expect(client.calls.getProjects.length).toBeGreaterThan(
        projectsCountBefore,
      ),
    )
  })

  it("fetches projects on initial render", async () => {
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // The shell now fetches projects first; per-project session pages load lazily.
    await waitFor(() =>
      expect(client.calls.getProjects.length).toBeGreaterThan(0),
    )
  })

  it("requests the next page when 'Show 10 more' is clicked on a project group", async () => {
    // Project reports 15 sessions; first page loads 10 → "Show 10 more" button renders.
    const page = Array.from({ length: 10 }, (_, i) => ({
      id: `s_${i}`,
      harnessId: "claude",
      modelId: "m_1",
      startedAt: "2026-05-23T10:00:00.000Z",
      endedAt: "2026-05-23T10:05:00.000Z",
      exitCode: 0,
    }))
    const client = createFakeIpcClient({
      ...baseStubs,
      getProjects: async () => ({
        ok: true as const,
        value: [{ id: "prj_1", name: "demo", path: "/demo", sessionCount: 15 }],
      }),
      getSessions: async () => ({
        ok: true as const,
        value: page,
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    fireEvent.click(
      await screen.findByRole("button", { name: /show 10 more/i }),
    )
    // Bumping the limit re-runs the session query with the larger page size.
    await waitFor(() =>
      expect(client.calls.getSessions).toContainEqual({
        projectId: "prj_1",
        limit: 20,
      }),
    )
  })

  it("hides the 'Show 10 more' button when all project sessions are loaded", async () => {
    // Project reports 1 session; loaded page also has 1 → no more to load.
    const page = [
      {
        id: "s_0",
        harnessId: "claude",
        modelId: "m_1",
        startedAt: "2026-05-23T10:00:00.000Z",
        endedAt: "2026-05-23T10:05:00.000Z",
        exitCode: 0,
      },
    ]
    const client = createFakeIpcClient({
      ...baseStubs,
      getProjects: async () => ({
        ok: true as const,
        value: [{ id: "prj_1", name: "demo", path: "/demo", sessionCount: 1 }],
      }),
      getSessions: async () => ({
        ok: true as const,
        value: page,
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    await waitFor(() =>
      expect(screen.getByText(/claude · m_1/)).toBeInTheDocument(),
    )
    expect(screen.queryByRole("button", { name: /show 10 more/i })).toBeNull()
  })

  it("refetches getModels (and getHarnesses) when the new-session modal is opened (Fix #1)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Wait for initial render — hooks fire on mount for models, harnesses
    await waitFor(() =>
      expect(client.calls.getModels.length).toBeGreaterThan(0),
    )
    const countBefore = client.calls.getModels.length

    // Open the modal via "+ New session" button — onNew should trigger refetch
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))

    // After opening, getModels should have been called again
    await waitFor(() =>
      expect(client.calls.getModels.length).toBeGreaterThan(countBefore),
    )
    // Same for getHarnesses
    const harnessCountAfterOpen = client.calls.getHarnesses.length
    expect(harnessCountAfterOpen).toBeGreaterThan(0)
  })

  it("sets the folder field in the modal when pickFolder returns a real path (Fix #2)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      pickFolder: async () => ({
        ok: true as const,
        value: { path: "/Users/me/myproject" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Open modal then click Browse
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    await screen.findByRole("button", { name: /launch/i })
    fireEvent.click(screen.getByRole("button", { name: /browse/i }))
    // After Browse resolves, the Folder field should show the returned path
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue(
        "/Users/me/myproject",
      ),
    )
  })

  it("prefills the folder field from the persisted lastSelectedFolder setting (B2)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      getSettings: async () => ({
        ok: true as const,
        value: {
          lastSelectedFolder: "/seed/dir",
          lastSelectedHarnessId: "",
          collapsedProjects: [],
        },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Open the modal; its Folder field should already carry the persisted folder.
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    await screen.findByRole("button", { name: /launch/i })
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /folder/i })).toHaveValue(
        "/seed/dir",
      ),
    )
  })

  it("prefills the harness from settings (the modal no longer carries a model field)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
          {
            id: "codex",
            name: "Codex",
            command: "codex",
            apiFormat: "openai",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [
          { id: "mdl_fast", providerId: "p_openai", providerModel: "gpt-4o" },
        ],
      }),
      getSettings: async () => ({
        ok: true as const,
        value: {
          lastSelectedFolder: "/seed/dir",
          lastSelectedHarnessId: "codex",
          collapsedProjects: [],
        },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Open the modal; the harness select must carry the persisted id
    // (page-level fetch → props), not the first-harness fallback.
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    await screen.findByRole("button", { name: /launch/i })
    await waitFor(() =>
      expect(screen.getByLabelText("Harness")).toHaveValue("codex"),
    )
    // The Model field is gone — model selection lives in the composer now.
    expect(screen.queryByLabelText("Model")).toBeNull()
  })

  it("surfaces a pickFolder error as an alert in the modal (Fix #2)", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      pickFolder: async () => ({
        ok: false as const,
        error: { kind: "handler-failed" as const, detail: "dialog failed" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // Open modal then click Browse (which will fail)
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    await screen.findByRole("button", { name: /launch/i })
    fireEvent.click(screen.getByRole("button", { name: /browse/i }))
    // The error should be surfaced as an alert
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/dialog failed/i),
    )
  })

  it("uses a folder-picker error label (not 'Could not launch session') when pickFolder fails", async () => {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            apiFormat: "anthropic",
            envTemplate: {},
            builtIn: true,
          },
        ],
      }),
      getModels: async () => ({
        ok: true as const,
        value: [{ id: "m_1", providerId: "p_openai", providerModel: "gpt-4o" }],
      }),
      pickFolder: async () => ({
        ok: false as const,
        error: { kind: "handler-failed" as const, detail: "access denied" },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }))
    await screen.findByRole("button", { name: /launch/i })
    fireEvent.click(screen.getByRole("button", { name: /browse/i }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/folder picker/i),
    )
    // Must NOT use the session-launch label for a folder-picker failure
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /could not launch session/i,
    )
  })

  // --- Background run-finished toast (the onAny → app.tsx effect end-to-end) ---
  // These drive a REAL `runner-finished` frame through the REAL runner client's
  // `dispatch`, which fans out via `onAny` to the App's toast effect. The toast
  // outcome (or its suppression) is the behavior under test.

  it("toasts 'A run finished' when a BACKGROUND session completes", async () => {
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    // No session is currently viewed (#sessions), so a finished one is "background".
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    act(() => {
      // Establish the session's root runner first, then finish it.
      runnerClient.dispatch(rootStart("s_bg" as SessionId))
      runnerClient.dispatch(finishedFrame("s_bg" as SessionId, "completed"))
    })
    expect(await screen.findByText("A run finished")).toBeInTheDocument()
    // It's the info tone, not the error tone.
    expect(screen.queryByText("A run failed")).toBeNull()
  })

  it("toasts 'A run failed' when a background session errors", async () => {
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    act(() => {
      runnerClient.dispatch(rootStart("s_bg" as SessionId))
      runnerClient.dispatch(finishedFrame("s_bg" as SessionId, "errored"))
    })
    expect(await screen.findByText("A run failed")).toBeInTheDocument()
    expect(screen.queryByText("A run finished")).toBeNull()
  })

  it("does NOT toast when the finished session is the one being viewed (suppression)", async () => {
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        // Viewing s_open: a runner-finished for it must be suppressed.
        initialView="sessions/s_open"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions/s_open"))
    act(() => {
      runnerClient.dispatch(rootStart("s_open" as SessionId))
      runnerClient.dispatch(finishedFrame("s_open" as SessionId, "completed"))
    })
    // Let any async toast appearance settle, then assert it never showed.
    await waitFor(() => expect(window.location.hash).toBe("#sessions/s_open"))
    expect(screen.queryByText("A run finished")).toBeNull()
    expect(screen.queryByText("A run failed")).toBeNull()
  })

  it("does NOT toast when a background run is interrupted", async () => {
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    act(() => {
      runnerClient.dispatch(rootStart("s_bg" as SessionId))
      runnerClient.dispatch(finishedFrame("s_bg" as SessionId, "interrupted"))
    })
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    expect(screen.queryByText("A run finished")).toBeNull()
    expect(screen.queryByText("A run failed")).toBeNull()
  })

  it("does NOT toast on a SUB-runner finish, but DOES on the subsequent ROOT finish", async () => {
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient(baseStubs)
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    act(() => {
      // Root start establishes the session's root; a sub-agent starts + finishes mid-run.
      runnerClient.dispatch(rootStart("s_bg" as SessionId))
      runnerClient.dispatch(
        startedFrame("s_bg" as SessionId, "run_sub", ROOT_RUNNER),
      )
      runnerClient.dispatch(
        finishedFrame2("s_bg" as SessionId, "run_sub", "completed"),
      )
    })
    // The sub-agent finish must NOT toast.
    await waitFor(() => expect(window.location.hash).toBe("#sessions"))
    expect(screen.queryByText("A run finished")).toBeNull()
    // The ROOT finish DOES toast.
    act(() => {
      runnerClient.dispatch(finishedFrame("s_bg" as SessionId, "completed"))
    })
    expect(await screen.findByText("A run finished")).toBeInTheDocument()
  })
})

describe("App — skipAttach is sticky across resume (no double-replay)", () => {
  it("does NOT call runnerClient.attach after the manager's first live event arrives during a resumed session", async () => {
    // C1: the previous behavior cleared `skipAttachIds` on the FIRST live
    // event, which caused `LiveRunDetail`'s effect to re-run with
    // skipAttach=false and call `runnerClient.attach` — leading to a
    // double-replay of the stored backlog (manager's events.read replay
    // + a redundant run-attach). The fix makes skipAttach sticky: the
    // manager owns the replay, so attach must NEVER be called for a
    // resumed session during its lifetime.
    let attachCount = 0
    const runnerClient = createRunnerClient((m) => {
      if (m.type === "run-attach") attachCount += 1
    })
    const client = createFakeIpcClient({
      ...baseStubs,
      getProjects: async () => ({
        ok: true as const,
        value: [
          {
            id: "p1",
            name: "Project",
            sessions: [
              {
                id: "s_v" as SessionId,
                harnessId: "claude",
                cwd: "/tmp",
                startedAt: "2026-06-16T10:00:00.000Z",
              },
            ],
          },
        ],
      }),
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            {
              seq: 0,
              sessionId: "s_v" as SessionId,
              ts: "2026-06-16T10:00:00.000Z",
              event: {
                type: "runner-started",
                runnerId: ROOT_RUNNER as never,
              },
            },
          ],
        },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions/s_v"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions/s_v"))
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument())
    // Trigger resume: openSession + skipAttachIds.add + runnerClient.send.
    act(() => {
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "go" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    })
    // LiveRunDetail mounted with skipAttach=true: attach was never called.
    expect(attachCount).toBe(0)
    // First live event (simulating the manager's resumed stream arriving).
    act(() => {
      runnerClient.dispatch({
        type: "runner-event",
        id: "s_v" as SessionId,
        event: {
          seq: 1,
          sessionId: "s_v" as SessionId,
          ts: "2026-06-16T10:00:01.000Z",
          event: {
            type: "text-delta",
            runnerId: ROOT_RUNNER as never,
            messageId: "m1",
            text: "live delta",
          },
        },
      })
    })
    // skipAttach must remain sticky: attach is STILL never called.
    // (Previously, the first live event cleared skipAttachIds, causing
    // LiveRunDetail's effect to re-run with skipAttach=false → attach.)
    expect(attachCount).toBe(0)
  })
})

describe("App — firehose populates runViewStore (defense-in-depth)", () => {
  it("populates the runViewStore via onAny when events arrive during a resume (LiveRunDetail per-session listener may not be wired yet)", async () => {
    // Race scenario: the manager replays the backlog via runner-event frames.
    // If the webview's per-session listener on LiveRunDetail hasn't mounted yet
    // (effect timing), the events would be lost. The firehose effect (`onAny`)
    // calls `applyEvent` so the store is populated regardless of listener state.
    //
    // Driving path: render the App with a session selected in replay mode
    // (selectedSessionId via the hash); the replay composer is enabled with
    // `onResumeSend` wired. Click "Send message" → triggers `onResumeSend` →
    // adds to skipAttachIds + openSessionIds → flips to LiveRunDetail
    // (skipAttach=true, runViewStore empty → shows "Starting…"). Now dispatch
    // a runner-started + text-delta on the runner client. The firehose effect
    // must call applyEvent so the runViewStore is populated and the text
    // appears in the DOM.
    const runnerClient = createRunnerClient(() => {})
    const client = createFakeIpcClient({
      ...baseStubs,
      getProjects: async () => ({
        ok: true as const,
        value: [
          {
            id: "p1",
            name: "Project",
            sessions: [
              {
                id: "s_v" as SessionId,
                harnessId: "claude",
                cwd: "/tmp",
                startedAt: "2026-06-16T10:00:00.000Z",
              },
            ],
          },
        ],
      }),
      getRunEvents: async () => ({
        ok: true,
        value: {
          events: [
            {
              seq: 0,
              sessionId: "s_v" as SessionId,
              ts: "2026-06-16T10:00:00.000Z",
              event: {
                type: "runner-started",
                runnerId: ROOT_RUNNER as never,
              },
            },
            {
              seq: 1,
              sessionId: "s_v" as SessionId,
              ts: "2026-06-16T10:00:00.000Z",
              event: {
                type: "text-delta",
                runnerId: ROOT_RUNNER as never,
                messageId: "m0",
                text: "Recorded reply",
              },
            },
          ],
        },
      }),
    })
    render(
      <App
        client={client}
        runnerClient={runnerClient}
        updateClient={fakeUpdateClient}
        initialView="sessions/s_v"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe("#sessions/s_v"))
    // Wait for replay composer to render (recorded reply text + textbox).
    await waitFor(() =>
      expect(screen.getByText("Recorded reply")).toBeInTheDocument(),
    )
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument())
    act(() => {
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "continue" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    })
    // LiveRunDetail is now mounted (skipAttach=true, runViewStore empty).
    // The "Recorded reply" text is gone (ReplayRunDetail unmounted); the
    // placeholder shows "Starting…" until events arrive.
    await waitFor(() =>
      expect(screen.getByText(/Starting…/)).toBeInTheDocument(),
    )
    act(() => {
      runnerClient.dispatch({
        type: "runner-event",
        id: "s_v" as SessionId,
        event: {
          seq: 1,
          sessionId: "s_v" as SessionId,
          ts: "2026-06-16T10:00:01.000Z",
          event: {
            type: "runner-started",
            runnerId: ROOT_RUNNER as never,
          },
        },
      })
      runnerClient.dispatch({
        type: "runner-event",
        id: "s_v" as SessionId,
        event: {
          seq: 2,
          sessionId: "s_v" as SessionId,
          ts: "2026-06-16T10:00:02.000Z",
          event: {
            type: "text-delta",
            runnerId: ROOT_RUNNER as never,
            messageId: "m1",
            text: "From the firehose",
          },
        },
      })
    })
    expect(await screen.findByText("From the firehose")).toBeInTheDocument()
  })
})
