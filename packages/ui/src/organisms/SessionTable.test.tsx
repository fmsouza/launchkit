import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { SessionTable } from "./SessionTable"
import type { Session } from "@launchkit/types"

const sessions = [
  { id: "s_1", harnessId: "claude", alias: "default", startedAt: "2026-05-23T10:00:00.000Z", endedAt: "2026-05-23T10:05:00.000Z", exitCode: 0 },
  { id: "s_2", harnessId: "codex", alias: "fast", startedAt: "2026-05-23T11:00:00.000Z" },
  { id: "s_3", harnessId: "opencode", alias: "smart", startedAt: "2026-05-23T12:00:00.000Z", endedAt: "2026-05-23T12:01:00.000Z", exitCode: 1 },
] as unknown as readonly Session[]

describe("SessionTable", () => {
  it("renders a row per session showing harness and alias", () => {
    render(<SessionTable sessions={sessions} />)
    expect(screen.getByText("claude")).toBeInTheDocument()
    expect(screen.getByText("codex")).toBeInTheDocument()
    expect(screen.getByText("opencode")).toBeInTheDocument()
  })
  it("shows a running status when a session has not ended", () => {
    render(<SessionTable sessions={sessions} />)
    expect(screen.getByText("running")).toBeInTheDocument()
  })
  it("shows the exit code when a session has ended", () => {
    render(<SessionTable sessions={sessions} />)
    expect(screen.getByText("exit 0")).toBeInTheDocument()
    expect(screen.getByText("exit 1")).toBeInTheDocument()
  })
  it("renders at most maxVisible rows and notes the remainder when truncated", () => {
    render(<SessionTable sessions={sessions} maxVisible={2} />)
    expect(screen.getAllByRole("row")).toHaveLength(3) // 1 header + 2 body rows
    expect(screen.getByText("+1 more")).toBeInTheDocument()
  })
  it("shows an empty state when there are no sessions", () => {
    render(<SessionTable sessions={[]} />)
    expect(screen.getByRole("heading", { name: /no sessions/i })).toBeInTheDocument()
  })
})
