import type { Logger } from "@spectrum/logger"
import { createNoopLogger } from "@spectrum/logger"
import type { SessionId } from "@spectrum/types"
import type { Result } from "@spectrum/utils"
import type { TerminalError } from "./errors"
import type { TabId, TerminalInbound, TerminalOutbound } from "./protocol"
import type { PtySpawner } from "./pty-adapter"

export interface TerminalSession {
  readonly tabId: TabId
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface TerminalManagerDeps {
  readonly spawner: PtySpawner
  readonly log?: Logger
}

export interface TerminalManager {
  launch(input: {
    readonly sessionId: SessionId
    readonly tabId: TabId
    readonly cwd: string
    readonly cols: number
    readonly rows: number
    readonly env?: Record<string, string>
  }): Result<TerminalSession, TerminalError>
  handleInbound(frame: TerminalInbound): void
  bindSend(sink: (message: TerminalOutbound) => void): void
  dispose(sessionId: SessionId): void
}

interface LivePty {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly handle: import("./pty-adapter").PtyHandle
}

export const createTerminalManager = (
  deps: TerminalManagerDeps,
): TerminalManager => {
  const log = deps.log ?? createNoopLogger()
  // registry keyed by `${sessionId}::${tabId}`
  const live = new Map<string, LivePty>()
  let sink: (message: TerminalOutbound) => void = () => {}

  const key = (sessionId: SessionId, tabId: TabId) => `${sessionId}::${tabId}`

  const send = (m: TerminalOutbound): void => {
    try {
      sink(m)
    } catch (err) {
      log.error("terminal sink send failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const launch: TerminalManager["launch"] = (input) => {
    log.info("terminal-launched", {
      sessionId: input.sessionId,
      tabId: input.tabId,
      cwd: input.cwd,
    })
    const r = deps.spawner.spawn({
      command: process.env.SHELL ?? "/bin/zsh",
      args: ["-l"],
      cwd: input.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...(input.env ?? {}),
      },
      cols: input.cols,
      rows: input.rows,
    })
    if (!r.ok) {
      const message =
        r.error.kind === "spawn-failed" ? r.error.message : r.error.kind
      log.error("terminal spawn failed", {
        sessionId: input.sessionId,
        tabId: input.tabId,
        message,
      })
      return r
    }
    const handle = r.value
    const k = key(input.sessionId, input.tabId)
    live.set(k, { sessionId: input.sessionId, tabId: input.tabId, handle })
    handle.onData((bytes) => {
      send({
        type: "term-output",
        sessionId: input.sessionId,
        tabId: input.tabId,
        data: toBase64(bytes),
      })
    })
    handle.onExit((exitCode) => {
      log.info("terminal-exited", {
        sessionId: input.sessionId,
        tabId: input.tabId,
        exitCode,
      })
      live.delete(k)
      send({
        type: "term-exited",
        sessionId: input.sessionId,
        tabId: input.tabId,
        exitCode,
      })
    })
    send({
      type: "term-opened",
      sessionId: input.sessionId,
      tabId: input.tabId,
    })
    const session: TerminalSession = {
      tabId: input.tabId,
      write: (bytes) => handle.write(bytes),
      resize: (cols, rows) => handle.resize(cols, rows),
      kill: () => handle.kill(),
    }
    return { ok: true, value: session }
  }

  const handleInbound: TerminalManager["handleInbound"] = (frame) => {
    const k = key(frame.sessionId, frame.tabId)
    const entry = live.get(k)
    switch (frame.type) {
      case "term-open": {
        // First open for a tab spawns the PTY; a repeat term-open for a
        // live tab is an idempotent re-attach (the webview keeps its own
        // xterm scrollback, so there is nothing to replay server-side).
        if (entry) return
        launch({
          sessionId: frame.sessionId,
          tabId: frame.tabId,
          cwd: frame.cwd,
          cols: frame.cols,
          rows: frame.rows,
          ...(frame.env ? { env: frame.env } : {}),
        })
        return
      }
      case "term-attach": {
        // re-attach: the webview re-subscribes; no server-side replay (xterm holds scrollback)
        if (!entry) {
          send({
            type: "term-error",
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            message: "no such terminal to attach",
          })
        }
        return
      }
      case "term-input": {
        if (!entry) {
          send({
            type: "term-error",
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            message: "unknown tab",
          })
          return
        }
        entry.handle.write(fromBase64(frame.data))
        return
      }
      case "term-resize": {
        if (!entry) {
          send({
            type: "term-error",
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            message: "unknown tab",
          })
          return
        }
        entry.handle.resize(frame.cols, frame.rows)
        return
      }
      case "term-close": {
        if (!entry) {
          // already gone — nothing to do
          return
        }
        entry.handle.kill()
        return
      }
    }
  }

  const dispose: TerminalManager["dispose"] = (sessionId) => {
    for (const [k, entry] of live) {
      if (entry.sessionId === sessionId) {
        log.info("terminal-dispose", { sessionId, tabId: entry.tabId })
        entry.handle.kill()
        live.delete(k)
      }
    }
  }

  return {
    bindSend(next) {
      sink = next
    },
    launch,
    handleInbound,
    dispose,
  }
}

// base64 helpers (Uint8Array <-> base64 string). Node Buffer is available under Bun.
const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64")
const fromBase64 = (data: string): Uint8Array =>
  new Uint8Array(Buffer.from(data, "base64"))

/**
 * No-op terminal manager used when the native PTY addon cannot be loaded
 * (e.g. a packaged GUI build missing `node-pty`'s prebuilt). The webview
 * surfaces the resulting `{ kind: "not-implemented" }` as the "Terminal
 * unavailable" notice rather than crashing the app at boot.
 */
export const createNoopTerminalManager = (): TerminalManager => ({
  launch: () => ({ ok: false, error: { kind: "not-implemented" } }),
  handleInbound: () => {},
  bindSend: () => {},
  dispose: () => {},
})
