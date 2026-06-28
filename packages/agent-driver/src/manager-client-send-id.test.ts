import { expect, it } from "bun:test"
import type { CanonicalEvent, RunnerId } from "@spectrum/agent-events"
import {
  HarnessIdSchema,
  type Session,
  SessionIdSchema,
} from "@spectrum/types"
import { createFixedClock, ok } from "@spectrum/utils"
import type { AgentDriver, AgentSession } from "./driver"
import { createRunManager } from "./manager"
import type { RunEventSink, SessionSink } from "./ports"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)
const harnessId = HarnessIdSchema.parse("demo")
const root = "rnr_root" as RunnerId
const clock = createFixedClock(new Date("2026-06-08T12:00:00.000Z"))
const fakeSession: Session = {
  id: sessionId,
  harnessId,
  startedAt: "2026-06-08T00:00:00.000Z",
}

it("forwards run-send clientSendId to the live agent.send", () => {
  const sends: Array<{ text: string; clientSendId?: string }> = []
  const agent: AgentSession = {
    rootRunnerId: root,
    onEvent: () => {},
    send: (turn) => {
      sends.push(turn)
      return ok(undefined)
    },
    respondApproval: () => ok(undefined),
    respondQuestion: () => ok(undefined),
    interrupt: () => ok(undefined),
    close: () => ok(undefined),
  }
  const driver: AgentDriver = { start: () => ok(agent) }
  const sessions: SessionSink = {
    create: () => ok(fakeSession),
    close: () => ok(fakeSession),
    updateName: () => ok(fakeSession),
    setResumeId: () => ok(fakeSession),
    reopen: () => ok(fakeSession),
    get: () => ok(fakeSession),
  }
  const store: CanonicalEvent[] = []
  const events: RunEventSink = {
    append: (_id, event) => {
      store.push(event)
      return ok({ seq: store.length - 1 })
    },
    read: () => ok([]),
  }
  const manager = createRunManager({
    driver,
    sessions,
    events,
    clock,
    send: () => {},
  })
  manager.launch({ harnessId, cwd: "/tmp", env: {} })
  manager.handleInbound({
    type: "run-send",
    id: sessionId,
    text: "hello",
    clientSendId: "c1",
  })
  expect(sends).toEqual([{ text: "hello", clientSendId: "c1" }])
})
