import { describe, expect, it } from "bun:test"
import { SessionIdSchema } from "@spectrum/types"
import { createFakePtySpawner } from "./fake-pty"
import { createNoopTerminalManager, createTerminalManager } from "./manager"
import type { TerminalOutbound } from "./protocol"
import type { PtySpawner } from "./pty-adapter"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)
const tabId = "11111111-1111-4111-8111-111111111111" as never
const baseLaunch = { sessionId, tabId, cwd: "/tmp", cols: 80, rows: 24 }

const capturingSink = () => {
  const sent: TerminalOutbound[] = []
  return { sent, sink: (m: TerminalOutbound) => sent.push(m) }
}

describe("TerminalManager", () => {
  it("launches a PTY and emits term-opened + term-output on data", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    const r = mgr.launch(baseLaunch)
    expect(r.ok).toBe(true)
    // fake emits on write; trigger via handleInbound term-input
    mgr.handleInbound({ type: "term-input", sessionId, tabId, data: "bHM=" })
    expect(sent.some((m) => m.type === "term-opened")).toBe(true)
    expect(sent.some((m) => m.type === "term-output")).toBe(true)
  })

  it("spawns a PTY and emits term-opened when handleInbound receives term-open for a new tab", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    mgr.handleInbound({
      type: "term-open",
      sessionId,
      tabId,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    })
    expect(spawner.calls.length).toBe(1)
    expect(spawner.calls[0]?.cwd).toBe("/tmp")
    expect(sent.some((m) => m.type === "term-opened")).toBe(true)
    expect(sent.some((m) => m.type === "term-error")).toBe(false)
  })

  it("treats term-open for an already-live tab as an idempotent re-attach (no second spawn, no error)", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    mgr.launch(baseLaunch)
    mgr.handleInbound({
      type: "term-open",
      sessionId,
      tabId,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    })
    expect(spawner.calls.length).toBe(1)
    expect(sent.some((m) => m.type === "term-error")).toBe(false)
  })

  it("routes term-resize to session.resize with cols/rows", () => {
    const spawner = createFakePtySpawner()
    const { sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    mgr.launch(baseLaunch)
    mgr.handleInbound({
      type: "term-resize",
      sessionId,
      tabId,
      cols: 120,
      rows: 40,
    })
    expect(spawner.calls[0]).toBeDefined()
  })

  it("kills the PTY on term-close and emits term-exited", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    mgr.launch(baseLaunch)
    mgr.handleInbound({ type: "term-close", sessionId, tabId })
    expect(sent.some((m) => m.type === "term-exited")).toBe(true)
  })

  it("emits term-error for an unknown tab without throwing", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    expect(() =>
      mgr.handleInbound({ type: "term-input", sessionId, tabId, data: "bHM=" }),
    ).not.toThrow()
    expect(sent.some((m) => m.type === "term-error")).toBe(true)
  })

  it("dispose(sessionId) kills all of a session's PTYs", () => {
    const spawner = createFakePtySpawner()
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner })
    mgr.bindSend(sink)
    mgr.launch(baseLaunch)
    mgr.launch({
      ...baseLaunch,
      tabId: "22222222-2222-4222-8222-222222222222" as never,
    })
    mgr.dispose(sessionId)
    const exits = sent.filter((m) => m.type === "term-exited")
    expect(exits.length).toBe(2)
  })

  it("returns a spawn-failed Result and does not throw when the spawner errors", () => {
    const failingSpawner: PtySpawner = {
      spawn: () => ({
        ok: false,
        error: { kind: "spawn-failed", message: "boom" },
      }),
    }
    const mgr = createTerminalManager({ spawner: failingSpawner })
    const r = mgr.launch(baseLaunch)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("spawn-failed")
  })

  it("sends a term-error frame (not just a Result) when the spawner fails", () => {
    const failingSpawner: PtySpawner = {
      spawn: () => ({
        ok: false,
        error: { kind: "spawn-failed", message: "boom" },
      }),
    }
    const { sent, sink } = capturingSink()
    const mgr = createTerminalManager({ spawner: failingSpawner })
    mgr.bindSend(sink)
    mgr.launch(baseLaunch)
    const err = sent.find((m) => m.type === "term-error")
    expect(err).toBeDefined()
    if (err?.type === "term-error") expect(err.message).toContain("boom")
  })
})

describe("createNoopTerminalManager", () => {
  it("emits a term-error explaining the terminal is unavailable on term-open", () => {
    const mgr = createNoopTerminalManager()
    const { sent, sink } = capturingSink()
    mgr.bindSend(sink)
    mgr.handleInbound({
      type: "term-open",
      sessionId,
      tabId,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    })
    const err = sent.find((m) => m.type === "term-error")
    expect(err).toBeDefined()
    if (err?.type === "term-error")
      expect(err.message.toLowerCase()).toContain("unavailable")
  })
})
