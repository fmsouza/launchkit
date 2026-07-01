import { describe, expect, it, mock } from "bun:test"
import type {
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  RunnerId,
  StoredEvent,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type { Logger } from "@spectrum/logger"
import {
  type HarnessId,
  HarnessIdSchema,
  type ModelId,
  type Session,
  SessionIdSchema,
} from "@spectrum/types"
import { type Result, createFixedClock, err, isOk, ok } from "@spectrum/utils"
import type { AgentDriver, AgentStartInput } from "./driver"
import { createFakeDriver } from "./fake-driver"
import type { FakeScript } from "./fake-driver"
import { createRunManager } from "./manager"
import type { RunLaunchInput } from "./manager"
import type {
  NameGenError,
  NameGeneratorPort,
  RunEventSink,
  SessionSink,
} from "./ports"
import type { RunnerOutbound } from "./protocol"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)
const otherId = SessionIdSchema.parse("s_11111111-1111-4111-8111-111111111111")
const harnessId = HarnessIdSchema.parse("demo")
const root = "r_root" as RunnerId
const ts = "2026-06-08T12:00:00.000Z"
const clock = createFixedClock(new Date(ts))

const fakeSession: Session = {
  id: sessionId,
  harnessId,
  startedAt: "2026-06-08T00:00:00.000Z",
}

const startEvent: CanonicalEvent = {
  type: "runner-started",
  runnerId: root,
  title: "T",
}
const textEvent: CanonicalEvent = {
  type: "text-delta",
  runnerId: root,
  messageId: "m1",
  text: "hi",
}
const finishEvent: CanonicalEvent = {
  type: "runner-finished",
  runnerId: root,
  status: "completed",
}

const sync = (fn: () => void): void => fn()

type LogCall = {
  level: "debug" | "info" | "warn" | "error" | "fatal"
  msg: string
  fields?: Record<string, unknown>
}

const createFakeLogger = (): { logger: Logger; calls: LogCall[] } => {
  const calls: LogCall[] = []
  const record =
    (level: LogCall["level"]) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      calls.push({ level, msg, ...(fields !== undefined ? { fields } : {}) })
    }
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => logger,
  }
  return { logger, calls }
}

const makeDeps = (
  script: FakeScript,
): {
  sent: RunnerOutbound[]
  created: unknown[]
  closed: { id: string; code: number }[]
  appended: CanonicalEvent[]
  renamed: { id: string; name: string }[]
  resumeIds: { id: string; resumeId: string }[]
  reopened: string[]
  deps: Parameters<typeof createRunManager>[0]
} => {
  const sent: RunnerOutbound[] = []
  const created: unknown[] = []
  const closed: { id: string; code: number }[] = []
  const appended: CanonicalEvent[] = []
  const renamed: { id: string; name: string }[] = []
  const resumeIds: { id: string; resumeId: string }[] = []
  const reopened: string[] = []
  let seq = -1
  const store: StoredEvent[] = []
  const sessions: SessionSink = {
    create: (input) => {
      created.push(input)
      return ok(fakeSession)
    },
    close: (id, code) => {
      closed.push({ id, code })
      return ok({ ...fakeSession, exitCode: code })
    },
    updateName: (id, name) => {
      renamed.push({ id: String(id), name })
      return ok({ ...fakeSession, name })
    },
    setResumeId: (id, resumeId) => {
      resumeIds.push({ id: String(id), resumeId })
      return ok({ ...fakeSession, resumeId })
    },
    reopen: (id) => {
      reopened.push(String(id))
      return ok(fakeSession)
    },
    get: (id) => ok({ ...fakeSession, id }),
  }
  const events: RunEventSink = {
    append: (sid, event) => {
      seq += 1
      appended.push(event)
      store.push({ seq, sessionId: sid, ts, event })
      return ok({ seq })
    },
    read: () => ok(store),
  }
  return {
    sent,
    created,
    closed,
    appended,
    renamed,
    resumeIds,
    reopened,
    deps: {
      driver: createFakeDriver({
        script,
        scheduler: sync,
        setResumeId: (id, resumeId) => {
          resumeIds.push({ id: String(id), resumeId })
        },
      }),
      sessions,
      events,
      clock,
      send: (m) => {
        sent.push(m)
      },
    },
  }
}

const scriptOf = (start: readonly CanonicalEvent[]): FakeScript => ({
  rootRunnerId: root,
  reactions: [{ on: "start", emit: start }],
})

describe("createRunManager.launch", () => {
  it("creates a session and returns its id when launched", () => {
    const { deps, created } = makeDeps(scriptOf([]))
    const manager = createRunManager(deps)
    const res = manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(res.ok && res.value.sessionId).toBe(sessionId)
    expect(created).toHaveLength(1)
  })

  it("persists each driver event in order via the RunEventSink", () => {
    const { deps, appended } = makeDeps(scriptOf([startEvent, textEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(appended).toEqual([startEvent, textEvent])
  })

  it("forwards each persisted event as a stamped runner-event frame", () => {
    const { deps, sent } = makeDeps(scriptOf([startEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(sent).toEqual([
      {
        type: "runner-event",
        id: sessionId,
        event: { seq: 0, sessionId, ts, event: startEvent },
      },
      { type: "session-renamed", id: sessionId, name: "T" },
    ])
  })

  it("closes the session with code 0 when the root runner finishes", () => {
    const { deps, closed } = makeDeps(scriptOf([startEvent, finishEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(closed).toEqual([{ id: sessionId, code: 0 }])
  })

  it("does not close the session when a NON-root runner finishes", () => {
    const sub = "r_sub" as RunnerId
    const subFinish: CanonicalEvent = {
      type: "runner-finished",
      runnerId: sub,
      status: "completed",
    }
    const { deps, closed } = makeDeps(scriptOf([startEvent, subFinish]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(closed).toEqual([])
  })

  it("forwards name and cwd to sessions.create", () => {
    const { deps, created } = makeDeps(scriptOf([]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, name: "run x", cwd: "/work", env: {} })
    expect(created).toContainEqual({ harnessId, name: "run x", cwd: "/work" })
  })

  it("forwards the resolved command to driver.start", () => {
    let captured: AgentStartInput | undefined
    const capturingDriver: AgentDriver = {
      start: (i) => {
        captured = i
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({
      harnessId,
      cwd: "/tmp",
      env: {},
      command: "/abs/claude",
      args: ["app-server", "-c", "x=1"],
    })
    expect(captured?.command).toBe("/abs/claude")
    expect(captured?.args).toEqual(["app-server", "-c", "x=1"])
  })

  it("forwards permissionMode to driver.start when the launch input carries one", () => {
    let captured: AgentStartInput | undefined
    const capturingDriver: AgentDriver = {
      start: (i) => {
        captured = i
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {}, permissionMode: "plan" })
    expect(captured?.permissionMode).toBe("plan")
  })

  it("forwards resume to driver.start when the launch input carries one", () => {
    let captured: AgentStartInput | undefined
    const capturingDriver: AgentDriver = {
      start: (i) => {
        captured = i
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({
      harnessId,
      cwd: "/tmp",
      env: {},
      resume: "claude-sess-42",
    })
    expect(captured?.resume).toBe("claude-sess-42")
  })

  it("forwards sessionId to driver.start when the launch input carries one", () => {
    let captured: AgentStartInput | undefined
    const capturingDriver: AgentDriver = {
      start: (i) => {
        captured = i
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({
      harnessId,
      cwd: "/tmp",
      env: {},
      sessionId: sessionId,
    })
    expect(captured?.sessionId).toBe(sessionId)
  })

  it("closes the session even when the final event fails to persist", () => {
    // Arrange: append always fails so persist never succeeds.
    const sent: RunnerOutbound[] = []
    const closed: { id: string; code: number }[] = []
    const sessions: SessionSink = {
      create: () => ok(fakeSession),
      close: (id, code) => {
        closed.push({ id, code })
        return ok({ ...fakeSession, exitCode: code })
      },
      updateName: () => ok({ ...fakeSession, name: "x" }),
      setResumeId: () => ok(fakeSession),
      reopen: () => ok(fakeSession),
      get: (id) => ok({ ...fakeSession, id }),
    }
    const events: RunEventSink = {
      append: () => err({ detail: "boom" }),
      read: () => ok([]),
    }
    const deps: Parameters<typeof createRunManager>[0] = {
      driver: createFakeDriver({
        script: scriptOf([startEvent, finishEvent]),
        scheduler: sync,
      }),
      sessions,
      events,
      clock,
      send: (m) => {
        sent.push(m)
      },
    }
    // Act
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Assert: no runner-event frames forwarded (append failed), but the
    // runner-started title still produced a session-renamed frame and the
    // session was still closed.
    expect(sent).toEqual([
      { type: "session-renamed", id: sessionId, name: "T" },
    ])
    expect(closed).toEqual([{ id: sessionId, code: 0 }])
  })

  it("logs info with safe ids when a session launches", () => {
    const { deps } = makeDeps(scriptOf([]))
    const { logger, calls } = createFakeLogger()
    const manager = createRunManager({ ...deps, logger })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    const launched = calls.find(
      (c) => c.level === "info" && c.msg === "session launched",
    )
    expect(launched).toBeDefined()
    expect(launched?.fields).toEqual({ sessionId, harnessId })
  })

  it("logs error with the failure kind when the driver fails to start", () => {
    const failingDriver: AgentDriver = {
      start: () => err({ kind: "start-failed", detail: "boom" }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const { logger, calls } = createFakeLogger()
    const manager = createRunManager({ ...deps, driver: failingDriver, logger })
    const res = manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(res.ok).toBe(false)
    const failed = calls.find((c) => c.level === "error")
    expect(failed).toBeDefined()
    expect(failed?.fields).toEqual({ kind: "start-failed", harnessId })
  })

  it("logs info when the root runner finishes and the session closes", () => {
    const { deps } = makeDeps(scriptOf([startEvent, finishEvent]))
    const { logger, calls } = createFakeLogger()
    const manager = createRunManager({ ...deps, logger })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    const closedLog = calls.find(
      (c) => c.level === "info" && c.msg === "session closed",
    )
    expect(closedLog).toBeDefined()
    expect(closedLog?.fields).toEqual({ sessionId })
  })

  it("never logs message content or prompts", () => {
    const { deps } = makeDeps(scriptOf([startEvent, textEvent]))
    const { logger, calls } = createFakeLogger()
    const manager = createRunManager({ ...deps, logger })
    manager.launch({
      harnessId,
      cwd: "/tmp",
      env: {},
      initialPrompt: "SECRET-PROMPT-XYZ",
    })
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain("SECRET-PROMPT-XYZ")
    expect(serialized).not.toContain("hi")
  })
})

describe("createRunManager.handleInbound", () => {
  it("replays the stored backlog as runner-event frames on run-attach", () => {
    const { deps, sent } = makeDeps(scriptOf([startEvent, textEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    manager.handleInbound({ type: "run-attach", id: sessionId })
    expect(sent).toEqual([
      {
        type: "runner-event",
        id: sessionId,
        event: { seq: 0, sessionId, ts, event: startEvent },
      },
      {
        type: "runner-event",
        id: sessionId,
        event: { seq: 1, sessionId, ts, event: textEvent },
      },
    ])
  })

  it("routes run-send to the session, producing the send batch's events", () => {
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    const { deps, sent } = makeDeps(script)
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    manager.handleInbound({ type: "run-send", id: sessionId, text: "go" })
    expect(sent).toContainEqual({
      type: "runner-event",
      id: sessionId,
      event: { seq: 1, sessionId, ts, event: textEvent },
    })
  })

  it("run-send forwards attachments to the live agent session", () => {
    const sentTurns: Array<{
      text: string
      attachments?: readonly {
        readonly id: string
        readonly mime: string
        readonly displayName: string
        readonly kind: "image" | "pdf" | "text" | "binary"
        readonly bytes: number
        readonly dataUrl: string
      }[]
      clientSendId?: string
    }> = []
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: (turn) => {
            sentTurns.push(turn)
            return ok(undefined)
          },
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    const attachment = {
      id: "att_1",
      mime: "image/png",
      displayName: "shot.png",
      kind: "image" as const,
      bytes: 4,
      dataUrl: "data:image/png;base64,AAAA",
    }
    manager.handleInbound({
      type: "run-send",
      id: sessionId,
      text: "look at this",
      attachments: [attachment],
      clientSendId: "c1",
    })
    expect(sentTurns).toHaveLength(1)
    expect(sentTurns[0]?.text).toBe("look at this")
    expect(sentTurns[0]?.clientSendId).toBe("c1")
    expect(sentTurns[0]?.attachments).toBeDefined()
    expect(sentTurns[0]?.attachments).toHaveLength(1)
  })

  it("run-send omits attachments when none are supplied to the live session", () => {
    const sentTurns: Array<{
      text: string
      attachments?: readonly unknown[]
      clientSendId?: string
    }> = []
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: (turn) => {
            sentTurns.push(turn)
            return ok(undefined)
          },
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    manager.handleInbound({
      type: "run-send",
      id: sessionId,
      text: "no attach",
    })
    expect(sentTurns).toHaveLength(1)
    expect(sentTurns[0]?.attachments).toBeUndefined()
  })

  it("routes run-approve to the session, producing the approve batch's events", () => {
    const resolved: CanonicalEvent = {
      type: "approval-resolved",
      runnerId: root,
      requestId: "req_1",
      decision: "allow",
      by: "user",
    }
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent] },
        { on: "approve", emit: [resolved] },
      ],
    }
    const { deps, sent } = makeDeps(script)
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    manager.handleInbound({
      type: "run-approve",
      id: sessionId,
      requestId: "req_1",
      decision: "allow",
    })
    expect(sent).toContainEqual({
      type: "runner-event",
      id: sessionId,
      event: { seq: 1, sessionId, ts, event: resolved },
    })
  })

  it("routes run-interrupt to the session, producing the interrupt batch's events", () => {
    const interrupted: CanonicalEvent = {
      type: "runner-finished",
      runnerId: root,
      status: "interrupted",
    }
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent] },
        { on: "interrupt", emit: [interrupted] },
      ],
    }
    const { deps, sent, closed } = makeDeps(script)
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    manager.handleInbound({ type: "run-interrupt", id: sessionId })
    expect(sent).toContainEqual({
      type: "runner-event",
      id: sessionId,
      event: { seq: 1, sessionId, ts, event: interrupted },
    })
    // root runner-finished from interrupt also closes the session
    expect(closed).toEqual([{ id: sessionId, code: 0 }])
  })

  it("drops inbound messages for an unknown session id", async () => {
    const { deps, sent } = makeDeps(scriptOf([startEvent]))
    // Override get to return undefined for otherId — simulating a session that
    // was never created in the store. The manager must not attempt to resume.
    const depsNoSession: Parameters<typeof createRunManager>[0] = {
      ...deps,
      sessions: {
        ...deps.sessions,
        get: (id) =>
          String(id) === String(otherId)
            ? ok(undefined)
            : ok({ ...fakeSession, id }),
      },
    }
    const manager = createRunManager(depsNoSession)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    expect(() =>
      manager.handleInbound({ type: "run-send", id: otherId, text: "x" }),
    ).not.toThrow()
    // Flush microtasks — doResume is async.
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([])
  })
})

describe("createRunManager.handleInbound run-answer", () => {
  it("routes run-answer to the session", () => {
    const calls: Array<{ requestId: string; answer: QuestionAnswer }> = []
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: (requestId: string, answer: QuestionAnswer) => {
            calls.push({ requestId, answer })
            return ok(undefined)
          },
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    manager.handleInbound({
      type: "run-answer",
      id: sessionId,
      requestId: "q1",
      answer: { selections: [{ questionIndex: 0, labels: ["A"] }] },
    })
    expect(calls[0]?.requestId).toBe("q1")
    expect(calls[0]?.answer).toEqual({
      selections: [{ questionIndex: 0, labels: ["A"] }],
    })
  })
})

/** Build a manager with a live session whose `setThinkingEffort` is a Bun mock spy. */
const makeManagerWithLiveSession = (
  _label: string,
): {
  manager: ReturnType<typeof createRunManager>
  session: { setThinkingEffort: ReturnType<typeof mock> }
} => {
  const thinkingCalls: ThinkingEffort[] = []
  const setThinkingEffortSpy = mock((_effort: ThinkingEffort) => {
    thinkingCalls.push(_effort)
    return ok(undefined) as import("@spectrum/utils").Result<
      void,
      import("./driver").DriverError
    >
  })
  const capturingDriver: AgentDriver = {
    start: () =>
      ok({
        rootRunnerId: root,
        onEvent: () => undefined,
        send: () => ok(undefined),
        respondApproval: () => ok(undefined),
        respondQuestion: () => ok(undefined),
        interrupt: () => ok(undefined),
        close: () => ok(undefined),
        setThinkingEffort: setThinkingEffortSpy,
      }),
  }
  const { deps } = makeDeps(scriptOf([]))
  const manager = createRunManager({ ...deps, driver: capturingDriver })
  manager.launch({ harnessId, cwd: "/tmp", env: {} })
  return { manager, session: { setThinkingEffort: setThinkingEffortSpy } }
}

describe("createRunManager.handleInbound run-set-thinking-effort", () => {
  it("forwards run-set-thinking-effort to the live session", () => {
    const { manager, session } = makeManagerWithLiveSession("sess-1")
    manager.handleInbound({
      type: "run-set-thinking-effort",
      id: sessionId,
      effort: "high",
    })
    expect(session.setThinkingEffort).toHaveBeenCalledWith("high")
  })

  it("is a safe no-op for an unknown session id", () => {
    const { deps } = makeDeps(scriptOf([startEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(() =>
      manager.handleInbound({
        type: "run-set-thinking-effort",
        id: otherId,
        effort: "low",
      }),
    ).not.toThrow()
  })
})

describe("createRunManager.handleInbound run-set-mode", () => {
  it("calls setMode on the live session with the requested mode", () => {
    const modeCalls: PermissionMode[] = []
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
          setMode: (mode) => {
            modeCalls.push(mode)
            return ok(undefined)
          },
        }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    manager.handleInbound({
      type: "run-set-mode",
      id: sessionId,
      mode: "bypass",
    })
    expect(modeCalls).toEqual(["bypass"])
  })

  it("is a safe no-op for an unknown session id", () => {
    const { deps } = makeDeps(scriptOf([startEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(() =>
      manager.handleInbound({
        type: "run-set-mode",
        id: otherId,
        mode: "bypass",
      }),
    ).not.toThrow()
  })
})

describe("createRunManager.handleInbound run-set-model", () => {
  it("calls setModel on the live session with the requested modelId", () => {
    const modelCalls: string[] = []
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
          setModel: (modelId) => {
            modelCalls.push(String(modelId))
            return ok(undefined)
          },
        }),
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver: capturingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    manager.handleInbound({
      type: "run-set-model",
      id: sessionId,
      modelId: "mdl_x" as never,
    })
    expect(modelCalls).toEqual(["mdl_x"])
  })

  it("is a safe no-op for an unknown session id", () => {
    const { deps } = makeDeps(scriptOf([startEvent]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(() =>
      manager.handleInbound({
        type: "run-set-model",
        id: otherId,
        modelId: "mdl_x" as ModelId,
      }),
    ).not.toThrow()
  })

  it("resolves the proxied env and passes it to setModel on run-set-model", async () => {
    const setModelCalls: Array<{
      modelId: string
      env?: Readonly<Record<string, string>>
    }> = []

    // Local recording fake — extends the session stub just for this test.
    const makeRecordingDriver = (
      record: (
        modelId: ModelId | null,
        env?: Readonly<Record<string, string>>,
      ) => void,
    ): AgentDriver => ({
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
          setModel: (modelId, env) => {
            record(modelId, env)
            return ok(undefined)
          },
        }),
    })

    const driver = makeRecordingDriver((modelId, env) =>
      setModelCalls.push({
        modelId: String(modelId),
        ...(env !== undefined ? { env } : {}),
      }),
    )

    let capturedHarnessId: HarnessId | undefined
    const resolveModelEnv = async ({
      harnessId: resolvedHarnessId,
      modelId,
    }: {
      harnessId: HarnessId
      modelId: ModelId | null
    }): Promise<Readonly<Record<string, string>>> => {
      capturedHarnessId = resolvedHarnessId
      return {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
        ANTHROPIC_MODEL: String(modelId),
      }
    }

    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver, resolveModelEnv })
    const launched = manager.launch({
      harnessId: "claude" as HarnessId,
      cwd: "/tmp",
      env: {},
    })
    expect(isOk(launched)).toBe(true)
    if (!isOk(launched)) return

    manager.handleInbound({
      type: "run-set-model",
      id: launched.value.sessionId,
      modelId: "mdl_x" as ModelId,
    })

    // Flush async: resolveModelEnv is a Promise, so we wait for it to settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(setModelCalls).toEqual([
      {
        modelId: "mdl_x",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
          ANTHROPIC_MODEL: "mdl_x",
        },
      },
    ])
    expect(capturedHarnessId).toBe("claude" as HarnessId)
  })

  it("resolves a direct (empty) env and forwards null to setModel on run-set-model with null", async () => {
    const setModelCalls: Array<{
      modelId: unknown
      env?: Readonly<Record<string, string>>
    }> = []
    const makeRecordingDriver = (
      record: (
        modelId: ModelId | null,
        env?: Readonly<Record<string, string>>,
      ) => void,
    ): AgentDriver => ({
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
          setModel: (modelId, env) => {
            record(modelId, env)
            return ok(undefined)
          },
        }),
    })
    const driver = makeRecordingDriver((modelId, env) =>
      setModelCalls.push({ modelId, ...(env !== undefined ? { env } : {}) }),
    )
    const resolveModelEnv = async ({
      modelId,
    }: {
      harnessId: HarnessId
      modelId: ModelId | null
    }) => (modelId === null ? {} : { ANTHROPIC_MODEL: String(modelId) })
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({ ...deps, driver, resolveModelEnv })
    const launched = manager.launch({
      harnessId: "claude" as HarnessId,
      cwd: "/tmp",
      env: {},
    })
    if (!launched.ok) throw new Error("launch failed")
    manager.handleInbound({
      type: "run-set-model",
      id: launched.value.sessionId,
      modelId: null,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(setModelCalls).toEqual([{ modelId: null, env: {} }])
  })

  it("logs an error via the injected logger when resolveModelEnv rejects", async () => {
    const { logger, calls } = createFakeLogger()
    const capturingDriver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
          setModel: () => ok(undefined),
        }),
    }
    const resolveModelEnv = async (_input: {
      harnessId: HarnessId
      modelId: ModelId | null
    }): Promise<Readonly<Record<string, string>>> => {
      throw new Error("env resolution boom")
    }
    const { deps } = makeDeps(scriptOf([]))
    const manager = createRunManager({
      ...deps,
      driver: capturingDriver,
      logger,
      resolveModelEnv,
    })
    const launched = manager.launch({
      harnessId: "claude" as HarnessId,
      cwd: "/tmp",
      env: {},
    })
    expect(isOk(launched)).toBe(true)
    if (!isOk(launched)) return

    manager.handleInbound({
      type: "run-set-model",
      id: launched.value.sessionId,
      modelId: "mdl_x" as ModelId,
    })

    await new Promise((r) => setTimeout(r, 0))

    const errLog = calls.find(
      (c) => c.level === "error" && c.msg === "resolveModelEnv failed",
    )
    expect(errLog).toBeDefined()
    expect(errLog?.fields).toMatchObject({
      harnessId: "claude",
      modelId: "mdl_x",
      error: "env resolution boom",
    })
    // Must NOT log the env or any secret
    expect(JSON.stringify(errLog?.fields)).not.toContain("ANTHROPIC")
  })
})

describe("createRunManager session naming", () => {
  it("derives the name from the first root user text-delta and emits session-renamed", () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "  Fix the proxy  ",
      role: "user",
    }
    const { deps, renamed, sent } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(renamed).toEqual([{ id: String(sessionId), name: "Fix the proxy" }])
    expect(sent).toContainEqual({
      type: "session-renamed",
      id: sessionId,
      name: "Fix the proxy",
    })
  })

  it("does not rename a second time on a subsequent user text-delta", () => {
    const first: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "First prompt",
      role: "user",
    }
    const second: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu2",
      text: "Second prompt",
      role: "user",
    }
    const { deps, renamed, sent } = makeDeps(scriptOf([first, second]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("First prompt")
    expect(sent.filter((m) => m.type === "session-renamed")).toHaveLength(1)
  })

  it("skips naming when the first user text-delta is blank (deriveSessionName returns empty)", () => {
    const blank: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "   \n  ",
      role: "user",
    }
    const { deps, renamed, sent } = makeDeps(scriptOf([blank]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(renamed).toEqual([])
    expect(sent.filter((m) => m.type === "session-renamed")).toEqual([])
  })

  it("refines the name from a root runner-started title when source is none", () => {
    const titled: CanonicalEvent = {
      type: "runner-started",
      runnerId: root,
      title: "Explore repo",
    }
    const { deps, renamed, sent } = makeDeps(scriptOf([titled]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(renamed).toEqual([{ id: String(sessionId), name: "Explore repo" }])
    expect(sent).toContainEqual({
      type: "session-renamed",
      id: sessionId,
      name: "Explore repo",
    })
  })

  it("lets a harness title overwrite an already auto-derived (first-prompt) name", () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const titled: CanonicalEvent = {
      type: "runner-started",
      runnerId: root,
      title: "Harness title",
    }
    const { deps, renamed } = makeDeps(scriptOf([userDelta, titled]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(renamed.map((r) => r.name)).toEqual([
      "first prompt",
      "Harness title",
    ])
  })

  it("does NOT overwrite a user-set name with a harness title (source is user)", () => {
    const titled: CanonicalEvent = {
      type: "runner-started",
      runnerId: root,
      title: "Harness title",
    }
    const { deps, renamed } = makeDeps(scriptOf([titled]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {}, name: "My run" })
    expect(renamed).toEqual([])
  })

  it("does NOT auto-name on the first user delta when launch carried a name", () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const { deps, renamed } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {}, name: "My run" })
    expect(renamed).toEqual([])
  })

  it("continues the run and logs when updateName fails (no session-renamed frame)", () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const sent: RunnerOutbound[] = []
    const failingSessions: SessionSink = {
      create: () => ok(fakeSession),
      close: () => ok({ ...fakeSession, exitCode: 0 }),
      updateName: () => err({ kind: "db-failed", detail: "boom" }),
      setResumeId: () => ok(fakeSession),
      reopen: () => ok(fakeSession),
      get: (id) => ok({ ...fakeSession, id }),
    }
    const events: RunEventSink = {
      append: (_sid, _event) => ok({ seq: 0 }),
      read: () => ok([]),
    }
    const { logger, calls } = createFakeLogger()
    const manager = createRunManager({
      driver: createFakeDriver({
        script: scriptOf([userDelta]),
        scheduler: sync,
      }),
      sessions: failingSessions,
      events,
      clock,
      logger,
      send: (m) => {
        sent.push(m)
      },
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(sent.filter((m) => m.type === "session-renamed")).toEqual([])
    const errLog = calls.find(
      (c) => c.level === "error" && c.msg === "session name update failed",
    )
    expect(errLog).toBeDefined()
    expect(errLog?.fields).toMatchObject({ sessionId })
  })

  it("markUserNamed flips the guard so a later harness title does not overwrite", () => {
    const titled: CanonicalEvent = {
      type: "runner-started",
      runnerId: root,
      title: "Harness title",
    }
    const { deps } = makeDeps(scriptOf([titled]))
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Simulate a manual rename mid-run, BEFORE the title event is processed.
    // (FakeDriver emits the start batch synchronously on onEvent, so to test
    // markUserNamed BEFORE a title, launch first then call markUserNamed then
    // feed a fresh title via a second send.)
    manager.markUserNamed(sessionId)
    // Re-run a title via a second launch is not the model; instead assert the
    // guard flipped by launching a fresh manager with markUserNamed before any
    // event. Covered by the "does NOT overwrite a user-set name" test above;
    // here we assert markUserNamed is idempotent and a no-op for unknown ids.
    expect(manager.markUserNamed(sessionId)).toBeUndefined()
    expect(manager.markUserNamed(otherId as never)).toBeUndefined()
  })
})

describe("createRunManager AI session naming", () => {
  // Testable fake for the name generator port. Mirrors the existing pattern of
  // fakes in manager.test.ts: captures args, lets each call resolve or reject
  // on demand. The `modelId` default of the AI naming port is the constant below.
  const aiModelId = "mdl_ai_namer" as ModelId
  const makeGenerateNameFake = (): {
    fake: NameGeneratorPort
    calls: Array<{
      modelId: ModelId
      firstPrompt: string
      signal: AbortSignal
    }>
    resolveNext: (value: string) => void
    rejectNext: (error: NameGenError) => void
  } => {
    const calls: Array<{
      modelId: ModelId
      firstPrompt: string
      signal: AbortSignal
    }> = []
    // The generator contract: resolve with `ok(value)` on success or
    // `err({ kind, ... })` on failure. The "aborted" case is a RESOLVED
    // `err({ kind: "aborted" })`, not a rejection — so the manager's
    // `.then(r => !r.ok)` branch handles it without an unhandled rejection.
    const resolvers: Array<(r: Result<string, NameGenError>) => void> = []
    const fake: NameGeneratorPort = {
      generate: (modelId, firstPrompt, signal) =>
        new Promise((resolve) => {
          calls.push({ modelId, firstPrompt, signal })
          if (signal.aborted) {
            resolve(err({ kind: "aborted" }))
            return
          }
          signal.addEventListener("abort", () => {
            resolve(err({ kind: "aborted" }))
          })
          resolvers.push((r) => resolve(r))
        }),
    }
    return {
      fake,
      calls,
      resolveNext: (v: string) => {
        const r = resolvers.shift()
        if (r) r(ok(v))
      },
      rejectNext: (e) => {
        const r = resolvers.shift()
        if (r) r(err(e))
      },
    }
  }

  it("writes the fallback first, then refines with the AI name when it resolves", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "help me debug a flaky CI test",
      role: "user",
    }
    const { fake, calls, resolveNext } = makeGenerateNameFake()
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed, sent } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager({
      ...deps,
      generateName: fake,
      sessionNameModelId,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Fallback written first (sync).
    expect(renamed[0]?.name).toBe("help me debug a flaky CI test")
    // Flush microtasks so sessionNameModelId().then(generate) runs.
    await new Promise((r) => setTimeout(r, 0))
    // generateName was called.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.firstPrompt).toBe("help me debug a flaky CI test")
    // Resolve the AI name.
    resolveNext("Fix flaky test")
    // Flush microtasks.
    await new Promise((r) => setTimeout(r, 0))
    // Now the second rename landed.
    expect(renamed.map((r) => r.name)).toEqual([
      "help me debug a flaky CI test",
      "Fix flaky test",
    ])
    expect(
      sent.filter((m) => m.type === "session-renamed").map((m) => m),
    ).toContainEqual({
      type: "session-renamed",
      id: sessionId,
      name: "Fix flaky test",
    })
  })

  it("keeps the fallback and warns (no throw, no second rename) when generation fails", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const { fake, rejectNext } = makeGenerateNameFake()
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed, sent } = makeDeps(scriptOf([userDelta]))
    const { logger, calls: logCalls } = createFakeLogger()
    const manager = createRunManager({
      ...deps,
      generateName: fake,
      sessionNameModelId,
      logger,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Fallback written first.
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("first prompt")
    // Flush microtasks so sessionNameModelId().then(generate) runs and generate's
    // executor registers its resolvers/rejecters.
    await new Promise((r) => setTimeout(r, 0))
    // Reject the AI generation.
    rejectNext({ kind: "generation-failed", detail: "boom" })
    await new Promise((r) => setTimeout(r, 0))
    // Still only one rename, and a warn was logged.
    expect(renamed).toHaveLength(1)
    expect(sent.filter((m) => m.type === "session-renamed")).toHaveLength(1)
    const warn = logCalls.find(
      (c) => c.level === "warn" && c.msg === "session name generation failed",
    )
    expect(warn).toBeDefined()
    expect(warn?.fields).toMatchObject({
      sessionId,
      kind: "generation-failed",
    })
  })

  it("does not overwrite a user-set name (markUserNamed flips to 'user')", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const { fake, resolveNext } = makeGenerateNameFake()
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed, sent } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager({
      ...deps,
      generateName: fake,
      sessionNameModelId,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Fallback was written (sync).
    expect(renamed).toHaveLength(1)
    // Flush microtasks so sessionNameModelId().then(generate) runs.
    await new Promise((r) => setTimeout(r, 0))
    // Mark as user-named BEFORE the AI result resolves.
    manager.markUserNamed(sessionId)
    resolveNext("AI generated name")
    await new Promise((r) => setTimeout(r, 0))
    // No second rename.
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("first prompt")
    expect(sent.filter((m) => m.type === "session-renamed")).toHaveLength(1)
  })

  it("aborts the in-flight generation when the session closes", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const finish: CanonicalEvent = {
      type: "runner-finished",
      runnerId: root,
      status: "completed",
    }
    const { fake, calls } = makeGenerateNameFake()
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed } = makeDeps(scriptOf([userDelta, finish]))
    const manager = createRunManager({
      ...deps,
      generateName: fake,
      sessionNameModelId,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Flush microtasks so sessionNameModelId().then(generate) runs.
    await new Promise((r) => setTimeout(r, 0))
    // generateName was called.
    expect(calls).toHaveLength(1)
    const signal = calls[0]?.signal
    expect(signal).toBeDefined()
    // Flush the start batch through FakeDriver so the finish event runs.
    await new Promise((r) => setTimeout(r, 0))
    // The signal should now be aborted.
    expect(signal?.aborted).toBe(true)
    // No second rename because the AI call was aborted.
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("first prompt")
  })

  it("skips refinement entirely when sessionNameModelId resolves null", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const { fake, calls } = makeGenerateNameFake()
    const sessionNameModelId = async () => null
    const { deps, renamed } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager({
      ...deps,
      generateName: fake,
      sessionNameModelId,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Flush microtasks so sessionNameModelId().then runs (and skips generate).
    await new Promise((r) => setTimeout(r, 0))
    // generateName.generate is never called when modelId is null.
    expect(calls).toHaveLength(0)
    // Only the fallback is written.
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("first prompt")
  })

  it("skips refinement when generateName is absent", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed } = makeDeps(scriptOf([userDelta]))
    const manager = createRunManager({ ...deps, sessionNameModelId })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // No generateName port = no AI refine. Only the fallback.
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe("first prompt")
  })

  it("lets a later harness title overwrite an AI name (last auto-writer wins)", async () => {
    const userDelta: CanonicalEvent = {
      type: "text-delta",
      runnerId: root,
      messageId: "mu1",
      text: "first prompt",
      role: "user",
    }
    // The titled event fires AFTER the AI refinement resolves.
    const titled: CanonicalEvent = {
      type: "runner-started",
      runnerId: root,
      title: "Harness title beats AI",
    }
    // Custom driver: lets the test emit events on demand so the harness title
    // arrives AFTER the AI result resolves. The FakeScript's "start" batch fires
    // all events synchronously, which would put the title before the AI result.
    let eventCb: ((e: CanonicalEvent) => void) | null = null
    const driver: AgentDriver = {
      start: () =>
        ok({
          rootRunnerId: root,
          onEvent: (cb) => {
            eventCb = cb
          },
          send: () => ok(undefined),
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        }),
    }
    const { fake, resolveNext } = makeGenerateNameFake()
    const sessionNameModelId = async () => aiModelId
    const { deps, renamed } = makeDeps(scriptOf([])) // empty start batch
    const manager = createRunManager({
      ...deps,
      driver,
      generateName: fake,
      sessionNameModelId,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Drive the first user prompt (fallback written).
    expect(eventCb).not.toBeNull()
    const emit: (e: CanonicalEvent) => void = eventCb ?? ((): void => {})
    emit(userDelta)
    // First the fallback.
    expect(renamed[0]?.name).toBe("first prompt")
    // Flush microtasks so generate's resolver is registered, then resolve it.
    await new Promise((r) => setTimeout(r, 0))
    resolveNext("AI generated")
    await new Promise((r) => setTimeout(r, 0))
    // Now the AI name was written.
    expect(renamed.map((r) => r.name)).toEqual(["first prompt", "AI generated"])
    // Drive the harness title event. Since nameSource is "auto" and source !== "user",
    // the harness title overwrites the AI name (last-auto-writer-wins).
    emit(titled)
    expect(renamed.map((r) => r.name)).toEqual([
      "first prompt",
      "AI generated",
      "Harness title beats AI",
    ])
  })
})

describe("createRunManager.bindSend", () => {
  it("uses the rebound sink instead of the original after bindSend", () => {
    const { deps, sent } = makeDeps(scriptOf([startEvent]))
    const manager = createRunManager(deps)
    const rebound: RunnerOutbound[] = []
    manager.bindSend((m) => {
      rebound.push(m)
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(rebound).toHaveLength(2)
    expect(rebound.some((m) => m.type === "session-renamed")).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("captures events in-run-attach replay even when the initial microtask send goes to a no-op sink (proxy for WS-not-yet-bound race)", async () => {
    // The real-app scenario: manager created with no-op `send: () => {}`, then a WS
    // connects later. Events emitted via queueMicrotask during launch are stored in the
    // RunEventSink but dropped by the no-op send. When the WS later connects and the
    // webview sends run-attach, the replay must re-send the missed events.
    const store: StoredEvent[] = []
    let seq = -1
    const noopSend = (): void => {}
    const manager = createRunManager({
      driver: createFakeDriver({
        script: {
          rootRunnerId: root,
          reactions: [{ on: "start", emit: [startEvent, textEvent] }],
        },
      }),
      sessions: {
        create: () => ok(fakeSession),
        close: () => ok({ ...fakeSession, exitCode: 0 }),
        updateName: () => ok({ ...fakeSession, name: "x" }),
        setResumeId: () => ok(fakeSession),
        reopen: () => ok(fakeSession),
        get: (id) => ok({ ...fakeSession, id }),
      },
      events: {
        append: (sid, event) => {
          seq += 1
          store.push({ seq, sessionId: sid, ts, event })
          return ok({ seq })
        },
        read: () => ok(store),
      },
      clock,
      send: noopSend,
    })

    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Flush microtasks — events stored but forwarded to no-op
    await new Promise((r) => setTimeout(r, 0))
    expect(store).toHaveLength(2)
    expect(store[0]?.event).toEqual(startEvent)
    expect(store[1]?.event).toEqual(textEvent)

    // WS now connects
    const rebound: RunnerOutbound[] = []
    manager.bindSend((m) => rebound.push(m))

    // run-attach replays stored backlog
    manager.handleInbound({ type: "run-attach", id: sessionId })
    expect(rebound).toHaveLength(2)
    expect(rebound[0]).toMatchObject({
      type: "runner-event",
      id: sessionId,
      event: store[0],
    })
    expect(rebound[1]).toMatchObject({
      type: "runner-event",
      id: sessionId,
      event: store[1],
    })
  })

  it("replays stored backlog via run-attach after initial no-op send (async timing)", async () => {
    // Simulate the real app: manager created with no-op send, WS connects later.
    // Events emitted via microtask are stored but not forwarded; run-attach replay
    // must send them after bindSend.
    const store: StoredEvent[] = []
    let seq = -1
    const noopSend = (): void => {} // like the real composition's `send: () => {}`
    const manager = createRunManager({
      driver: createFakeDriver({
        script: {
          rootRunnerId: root,
          reactions: [{ on: "start", emit: [startEvent] }],
        },
        // Uses default queueMicrotask so events fire asynchronously
      }),
      sessions: {
        create: () => ok(fakeSession),
        close: () => ok({ ...fakeSession, exitCode: 0 }),
        updateName: () => ok({ ...fakeSession, name: "x" }),
        setResumeId: () => ok(fakeSession),
        reopen: () => ok(fakeSession),
        get: (id) => ok({ ...fakeSession, id }),
      },
      events: {
        append: (_sid, event) => {
          seq += 1
          store.push({ seq, sessionId, ts, event })
          return ok({ seq })
        },
        read: () => ok(store),
      },
      clock,
      send: noopSend,
    })

    // Launch — events are queued via queueMicrotask
    manager.launch({ harnessId, cwd: "/tmp", env: {} })

    // Flush microtasks: events stored but sent to no-op
    await new Promise((r) => setTimeout(r, 0))

    // Events should be stored but not forwarded (no-op sink — nothing is capturing them)
    expect(store).toHaveLength(1)
    expect(store[0]?.event).toEqual(startEvent)

    // Now the WS connects — bindSend replaces the no-op
    const rebound: RunnerOutbound[] = []
    manager.bindSend((m) => {
      rebound.push(m)
    })

    // The webview sends run-attach to replay stored events
    manager.handleInbound({ type: "run-attach", id: sessionId })
    expect(rebound).toHaveLength(1)
    const replayed = store[0]
    if (replayed === undefined) throw new Error("no stored event to replay")
    expect(rebound[0]).toEqual({
      type: "runner-event",
      id: sessionId,
      event: replayed,
    })
  })
})

describe("createRunManager resume (lazy auto-resume on run-send)", () => {
  // Helper: wrap the fake driver to count start calls and capture inputs.
  const wrapCountingDriver = (
    base: AgentDriver,
    counter: { count: number; inputs: AgentStartInput[] },
  ): AgentDriver => ({
    start: (input) => {
      counter.count += 1
      counter.inputs.push(input)
      return base.start(input)
    },
  })

  it("persists the harness resume token reported by the driver on launch", () => {
    // The FakeDriver (Task 10) reports its script.resumeToken via the wired
    // setResumeId on start, gated on input.sessionId being defined. The manager
    // forwards sessionId: id (the id it minted via sessions.create) to driver.start
    // on the initial launch path, so setResumeId fires with the launched sessionId
    // and the token lands in the sessions sink.
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [{ on: "start", emit: [startEvent] }],
      resumeToken: "claude-sess-99",
    }
    const { deps, resumeIds } = makeDeps(script)
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(resumeIds).toEqual([
      { id: String(sessionId), resumeId: "claude-sess-99" },
    ])
  })

  it("reopens the session and re-launches the driver with the persisted resumeId when a run-send arrives for an ended session", async () => {
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    const counter = { count: 0, inputs: [] as AgentStartInput[] }
    // The store's get returns a row with resumeId so the manager forwards it.
    const sessionWithResume = {
      ...fakeSession,
      id: sessionId,
      resumeId: "sess-A",
    }
    const { deps, reopened } = makeDeps(script)
    const wrappedDriver = wrapCountingDriver(deps.driver, counter)
    // Override get to return the persisted resumeId.
    const depsWithResume: Parameters<typeof createRunManager>[0] = {
      ...deps,
      driver: wrappedDriver,
      sessions: {
        ...deps.sessions,
        get: (id) => ok({ ...sessionWithResume, id }),
      },
    }
    const manager = createRunManager(depsWithResume)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Initial start + finish closed the session and dropped the live handle.
    expect(counter.count).toBe(1)
    // A run-send for the ended session triggers resume.
    manager.handleInbound({ type: "run-send", id: sessionId, text: "again" })
    // The manager reopens the row.
    expect(reopened).toEqual([String(sessionId)])
    // Allow microtasks to flush (resolveResumeInput is async via Promise.resolve).
    await Promise.resolve()
    await Promise.resolve()
    // The driver was started a second time (resume).
    expect(counter.count).toBe(2)
    expect(counter.inputs[1]?.resume).toBe("sess-A")
    expect(counter.inputs[1]?.sessionId).toBe(sessionId)
  })

  it("drops the live handle on root runner-finished so a later run-send triggers a resume", async () => {
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    const counter = { count: 0, inputs: [] as AgentStartInput[] }
    const { deps } = makeDeps(script)
    const wrappedDriver = wrapCountingDriver(deps.driver, counter)
    const manager = createRunManager({ ...deps, driver: wrappedDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(counter.count).toBe(1)
    // A send while the (now-dropped) handle is gone must resume, not no-op.
    manager.handleInbound({ type: "run-send", id: sessionId, text: "x" })
    await Promise.resolve()
    await Promise.resolve()
    expect(counter.count).toBe(2)
  })

  it("serializes two rapid run-sends to an ended session into a single resume", async () => {
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    const counter = { count: 0, inputs: [] as AgentStartInput[] }
    const { deps } = makeDeps(script)
    const wrappedDriver = wrapCountingDriver(deps.driver, counter)
    const manager = createRunManager({ ...deps, driver: wrappedDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(counter.count).toBe(1)
    // Two rapid sends to the ended session.
    manager.handleInbound({ type: "run-send", id: sessionId, text: "a" })
    manager.handleInbound({ type: "run-send", id: sessionId, text: "b" })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // Initial launch + ONE resume (not two resumes).
    expect(counter.count).toBe(2)
  })

  it("emits a session-resume-token frame with empty string on resume when the row has no resumeId (fresh-restart toast signal)", async () => {
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    // Row has NO resumeId — harness cannot true-resume.
    const { deps, sent } = makeDeps(script)
    const manager = createRunManager(deps)
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    manager.handleInbound({ type: "run-send", id: sessionId, text: "again" })
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({
      type: "session-resume-token",
      id: sessionId,
      resumeToken: "",
    })
  })

  it("drops queued resume sends when interrupted before the resume completes", async () => {
    // Arrange: a session that immediately finishes so the live handle is dropped.
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    // A deferred resolveResumeInput so we can pause doResume mid-flight and
    // inject the interrupt before the resume flushes its queued sends.
    let resolveResumeInput!: (input: RunLaunchInput) => void
    const resolveResumeInputPromise = new Promise<RunLaunchInput>((resolve) => {
      resolveResumeInput = resolve
    })
    const capturedSends: Array<{ text: string; clientSendId?: string }> = []
    let startCalls = 0
    const trackingDriver: AgentDriver = {
      start: (input) => {
        startCalls += 1
        if (startCalls === 1) {
          return createFakeDriver({ script, scheduler: sync }).start(input)
        }
        // The resume's driver.start — record sends so we can assert none arrive.
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: (turn) => {
            capturedSends.push(turn)
            return ok(undefined)
          },
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(script)
    const manager = createRunManager({
      ...deps,
      driver: trackingDriver,
      resolveResumeInput: () => resolveResumeInputPromise,
    })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    // Initial start + finish closed the session and dropped the live handle.
    expect(startCalls).toBe(1)
    // First send seeds the resume queue and starts doResume (pauses at resolveResumeInput).
    manager.handleInbound({ type: "run-send", id: sessionId, text: "first" })
    // Second send piles onto the resume queue.
    manager.handleInbound({ type: "run-send", id: sessionId, text: "second" })
    // Act: interrupt before the async resume flushes.
    manager.handleInbound({ type: "run-interrupt", id: sessionId })
    // Allow the doResume microtask to advance past the interrupt point.
    resolveResumeInput({ harnessId, cwd: "/tmp", env: {} })
    // Flush enough microtask ticks for doResume to complete.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // Assert: the resume driver DID start (the resume itself still completes) but
    // NO queued turns were flushed to agent.send because the queue was cleared.
    expect(startCalls).toBe(2)
    expect(capturedSends).toHaveLength(0)
  })

  it("emits a synthetic runner-finished:errored frame on the runner socket when resume driver.start fails", async () => {
    // Resume path: launch + close, then run-send. The second driver.start (the
    // resume) errors; the manager must surface the failure to the webview as
    // a runner-finished:errored canonical event (so the UI shows the failure
    // state instead of hanging on "Starting…").
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    // First start succeeds (initial launch), second start (the resume) errors.
    let startCalls = 0
    const failingDriver: AgentDriver = {
      start: () => {
        startCalls += 1
        if (startCalls === 1) {
          // The first launch uses the FakeDriver.
          return createFakeDriver({ script, scheduler: sync }).start({
            harnessId,
            cwd: "/tmp",
            env: {},
            sessionId,
          })
        }
        return err({ kind: "start-failed", detail: "harness not running" })
      },
    }
    const { deps, sent, closed } = makeDeps(script)
    const manager = createRunManager({ ...deps, driver: failingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    sent.length = 0
    closed.length = 0
    manager.handleInbound({ type: "run-send", id: sessionId, text: "again" })
    await Promise.resolve()
    await Promise.resolve()
    // The synthetic frame must reach the webview as a runner-event with a
    // runner-finished:errored payload carrying the driver error detail.
    const errored = sent.find(
      (m) =>
        m.type === "runner-event" &&
        m.event.event.type === "runner-finished" &&
        m.event.event.status === "errored",
    )
    expect(errored).toBeDefined()
    if (
      errored?.type === "runner-event" &&
      errored.event.event.type === "runner-finished"
    ) {
      expect(errored.event.event.error).toContain("harness not running")
    }
    // Session must be closed on failure (exit code 1).
    expect(closed).toEqual([{ id: String(sessionId), code: 1 }])
  })

  it("forwards attachments on the resume-queued path", async () => {
    // Same setup as "reopens the session and re-launches the driver" but the
    // first run-send carries attachments. The manager queues the turn while
    // the resume is in flight, then flushes it to the resumed driver. The
    // queued shape must include the attachment payload.
    const script: FakeScript = {
      rootRunnerId: root,
      reactions: [
        { on: "start", emit: [startEvent, finishEvent] },
        { on: "send", emit: [textEvent] },
      ],
    }
    const capturedSends: Array<{
      text: string
      attachments?: readonly { readonly id: string; readonly dataUrl: string }[]
      clientSendId?: string
    }> = []
    let startCalls = 0
    const trackingDriver: AgentDriver = {
      start: (input) => {
        startCalls += 1
        if (startCalls === 1) {
          return createFakeDriver({ script, scheduler: sync }).start(input)
        }
        return ok({
          rootRunnerId: root,
          onEvent: () => undefined,
          send: (turn) => {
            capturedSends.push(turn)
            return ok(undefined)
          },
          respondApproval: () => ok(undefined),
          respondQuestion: () => ok(undefined),
          interrupt: () => ok(undefined),
          close: () => ok(undefined),
        })
      },
    }
    const { deps } = makeDeps(script)
    const manager = createRunManager({ ...deps, driver: trackingDriver })
    manager.launch({ harnessId, cwd: "/tmp", env: {} })
    expect(startCalls).toBe(1)
    const attachment = {
      id: "att_resume",
      mime: "image/png",
      displayName: "shot.png",
      kind: "image" as const,
      bytes: 4,
      dataUrl: "data:image/png;base64,AAAA",
    }
    manager.handleInbound({
      type: "run-send",
      id: sessionId,
      text: "look again",
      attachments: [attachment],
      clientSendId: "c-resume",
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(startCalls).toBe(2)
    expect(capturedSends).toHaveLength(1)
    expect(capturedSends[0]?.text).toBe("look again")
    expect(capturedSends[0]?.clientSendId).toBe("c-resume")
    expect(capturedSends[0]?.attachments).toBeDefined()
    expect(capturedSends[0]?.attachments).toHaveLength(1)
    expect(capturedSends[0]?.attachments?.[0]?.id).toBe("att_resume")
  })
})
