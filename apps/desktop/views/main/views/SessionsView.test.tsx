import { describe, expect, it, mock } from "bun:test"
import type { RunnerOutbound } from "@spectrum/agent-driver"
import type { StoredEvent } from "@spectrum/agent-events"
import type { ModelRoute, Session, SessionId } from "@spectrum/types"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import type React from "react"
import { IpcClientProvider } from "../IpcClientContext"
import type { RunnerClient } from "../runner/runnerClient"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { SessionsView, sessionModelLabel } from "./SessionsView"

// ---------------------------------------------------------------------------
// sessionModelLabel — pure helper unit tests
// ---------------------------------------------------------------------------

const routes: readonly ModelRoute[] = [
  {
    id: "mdl_1" as ModelRoute["id"],
    providerId: "p_o" as ModelRoute["providerId"],
    providerModel: "kimi-k2.7-code:cloud",
  },
]
const providerNames = { p_o: "ollama" }

describe("sessionModelLabel", () => {
  it("resolves a model id to '<provider> / <providerModel>'", () => {
    expect(sessionModelLabel("mdl_1", routes, providerNames)).toBe(
      "ollama / kimi-k2.7-code:cloud",
    )
  })
  it("returns 'default' when the session has no model", () => {
    expect(sessionModelLabel(undefined, routes, providerNames)).toBe("default")
  })
  it("falls back to the raw id when the route is gone", () => {
    expect(sessionModelLabel("mdl_missing", routes, providerNames)).toBe(
      "mdl_missing",
    )
  })
  it("falls back to the provider id when the provider name is unknown", () => {
    expect(sessionModelLabel("mdl_1", routes, {})).toBe(
      "p_o / kimi-k2.7-code:cloud",
    )
  })
})

// A minimal fake RunnerClient that tracks attach() calls (mirrors RunDetail.test's fake).
const makeFakeRunner = (): RunnerClient & {
  readonly attached: SessionId[]
} => {
  const attached: SessionId[] = []
  return {
    attached,
    attach: (sid) => attached.push(sid),
    send: () => {},
    approve: () => {},
    interrupt: () => {},
    dispatch: (_m: RunnerOutbound) => {},
    onEvent: (_sid, _cb: (event: StoredEvent) => void) => {},
    onAny: () => () => {},
    onSessionRenamed: () => () => {},
    onResumeToken: () => () => {},
    connectionLost: () => {},
    onConnectionLost: () => () => {},
  }
}

const running = {
  id: "s_live",
  harnessId: "claude",
  modelId: "m_1",
  startedAt: "2026-05-23T10:00:00.000Z",
} as unknown as Session

const project = { id: "prj_1", name: "demo", sessionCount: 1 }

describe("SessionsView", () => {
  it("renders an empty state in the detail when nothing is selected", () => {
    const client = createFakeIpcClient({})
    const { detail } = SessionsView({
      selectedSessionId: undefined,
      openSessionIds: [],
      projects: [project],
      sessionsByProject: { prj_1: [running] },
      collapsed: new Set(),
      allSessions: [running],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession: () => {},
      runnerClient: makeFakeRunner(),
    })
    render(
      <IpcClientProvider client={client}>
        <div>{detail}</div>
      </IpcClientProvider>,
    )
    expect(screen.getByText(/no session selected/i)).toBeInTheDocument()
  })

  it("renders the sessions handed in via props in the master as project groups", () => {
    const client = createFakeIpcClient({})
    const { master } = SessionsView({
      selectedSessionId: undefined,
      openSessionIds: [],
      projects: [project],
      sessionsByProject: { prj_1: [running] },
      collapsed: new Set(),
      allSessions: [running],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession: () => {},
      runnerClient: makeFakeRunner(),
    })
    render(
      <IpcClientProvider client={client}>
        <div>{master}</div>
      </IpcClientProvider>,
    )
    // The master renders project groups — no data fetching here.
    expect(screen.getByText(/claude · m_1/)).toBeInTheDocument()
    expect(client.calls.getSessions.length).toBe(0)
    expect(client.calls.getProjects.length).toBe(0)
  })

  it("threads onDeleteSession through the master into ProjectList", () => {
    const client = createFakeIpcClient({})
    const onDeleteSession = mock((_id: SessionId) => {})
    const { master } = SessionsView({
      selectedSessionId: undefined,
      openSessionIds: [],
      projects: [project],
      sessionsByProject: { prj_1: [running] },
      collapsed: new Set(),
      allSessions: [running],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession,
      runnerClient: makeFakeRunner(),
    })
    render(
      <IpcClientProvider client={client}>
        <div>{master}</div>
      </IpcClientProvider>,
    )
    fireEvent.contextMenu(screen.getByText(/claude · m_1/))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete session" }),
    )
    expect(onDeleteSession).toHaveBeenCalledWith(running.id)
    cleanup()
  })

  it("shows the resolved provider/model label in the master when routes + providerNames are passed", () => {
    const client = createFakeIpcClient({})
    const modelRoute: ModelRoute = {
      id: "m_1" as ModelRoute["id"],
      providerId: "p_o" as ModelRoute["providerId"],
      providerModel: "kimi-k2.7-code:cloud",
    }
    const { master } = SessionsView({
      selectedSessionId: undefined,
      openSessionIds: [],
      projects: [project],
      sessionsByProject: { prj_1: [running] },
      collapsed: new Set(),
      allSessions: [running],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession: () => {},
      runnerClient: makeFakeRunner(),
      models: [modelRoute],
      providerNames: { p_o: "ollama" },
    })
    render(
      <IpcClientProvider client={client}>
        <div>{master}</div>
      </IpcClientProvider>,
    )
    // Model id "m_1" resolves to "ollama / kimi-k2.7-code:cloud"
    expect(
      screen.getByText(/claude · ollama \/ kimi-k2\.7-code:cloud/),
    ).toBeInTheDocument()
    // Raw model id must NOT appear
    expect(screen.queryByText(/claude · m_1/)).toBeNull()
    cleanup()
  })

  it("renders the native RunDetail (live) for an open session, attaching the runner socket", () => {
    const runner = makeFakeRunner()
    const { detail } = SessionsView({
      selectedSessionId: running.id,
      openSessionIds: [running.id],
      projects: [project],
      sessionsByProject: { prj_1: [running] },
      collapsed: new Set(),
      allSessions: [running],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession: () => {},
      runnerClient: runner,
    })
    renderWithProviders(detail as React.ReactElement, createFakeIpcClient({}))
    // Open session → live native path attaches the runner socket.
    expect(runner.attached).toEqual([running.id])
    cleanup()
  })

  it("folds stored events read-only (replay) for a selected ended session", () => {
    const ended = {
      id: "s_done",
      harnessId: "claude",
      modelId: "m_1",
      startedAt: "2026-05-23T10:00:00.000Z",
      endedAt: "2026-05-23T10:05:00.000Z",
      exitCode: 0,
    } as unknown as Session
    const runner = makeFakeRunner()
    const client = createFakeIpcClient({
      getRunEvents: async () => ({ ok: true as const, value: { events: [] } }),
    })
    const { detail } = SessionsView({
      selectedSessionId: ended.id,
      // Not in the open set → renders the read-only replay (no live attach).
      openSessionIds: [],
      projects: [project],
      sessionsByProject: { prj_1: [ended] },
      collapsed: new Set(),
      allSessions: [ended],
      onToggle: () => {},
      onMore: () => {},
      onSelect: () => {},
      onNew: () => {},
      onDeleteProject: () => {},
      onDeleteSession: () => {},
      runnerClient: runner,
    })
    renderWithProviders(detail as React.ReactElement, client)
    // Replay never attaches the live runner socket; it reads the stored events.
    expect(runner.attached).toEqual([])
    cleanup()
  })
})
