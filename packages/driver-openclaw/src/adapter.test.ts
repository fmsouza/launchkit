import { describe, expect, it } from "bun:test"
import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  RunnerId,
} from "@spectrum/agent-events"
import { createOpenclawAdapter } from "./adapter"
import type {
  OpenClawEvent,
  OpenclawConnectConfig,
  OpenclawRun,
  OpenclawTransport,
} from "./transport"

const ROOT = "rnr_root" as RunnerId

const START: AgentStartInput = {
  harnessId: "openclaw" as never,
  cwd: "/work",
  env: {
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_TOKEN: "tok",
    OPENCLAW_AGENT_ID: "default",
  },
  initialPrompt: "do the thing",
}

// A controllable fake run: push events, then end the stream.
class FakeRun implements OpenclawRun {
  readonly resolved: Array<{ id: string; decision: "allow" | "deny" }> = []
  cancelled = false
  closed = false
  private readonly queue: OpenClawEvent[] = []
  private done = false
  private wake: (() => void) | undefined
  push(e: OpenClawEvent): void {
    this.queue.push(e)
    this.wake?.()
  }
  end(): void {
    this.done = true
    this.wake?.()
  }
  async *events(): AsyncIterable<OpenClawEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()
        if (next !== undefined) yield next
      }
      if (this.done) return
      await new Promise<void>((r) => {
        this.wake = r
      })
    }
  }
  resolveApproval(id: string, decision: "allow" | "deny"): void {
    this.resolved.push({ id, decision })
  }
  cancel(): void {
    this.cancelled = true
  }
  close(): void {
    this.closed = true
  }
}

const setup = (decision: ApprovalDecision = "allow") => {
  const emitted: CanonicalEvent[] = []
  const run = new FakeRun()
  let lastConnect: OpenclawConnectConfig | undefined
  let sentText: string | undefined
  let disconnected = false
  const transport: OpenclawTransport = {
    run: () => run,
    send: ({ text }) => {
      sentText = text
    },
    disconnect: () => {
      disconnected = true
    },
  }
  // Mirror the real driver-runtime AdapterCtx: requestApproval OWNS the `approval-requested` emit
  // (with a fresh runtime requestId), so the adapter must NOT also emit the mapper's approval event.
  const ctx = {
    rootRunnerId: ROOT,
    emit: (e: CanonicalEvent) => emitted.push(e),
    newRunnerId: (): RunnerId => "rnr_child" as RunnerId,
    requestApproval: async (
      r: RunnerId,
      t: ApprovalTarget,
    ): Promise<ApprovalDecision> => {
      emitted.push({
        type: "approval-requested",
        runnerId: r,
        requestId: "apr_1",
        target: t,
      })
      return decision
    },
  }
  const adapter = createOpenclawAdapter({
    connect: async (config) => {
      lastConnect = config
      return transport
    },
  })
  return {
    adapter,
    ctx,
    run,
    emitted,
    get lastConnect() {
      return lastConnect
    },
    get sentText() {
      return sentText
    },
    get disconnected() {
      return disconnected
    },
  }
}

describe("createOpenclawAdapter", () => {
  it("connects with url/token/agentId/cwd from AgentStartInput.env and starts a run", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    expect(t.lastConnect).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "tok",
      agentId: "default",
      cwd: "/work",
    })
  })

  it("emits mapped canonical events from the run stream (run.started -> runner-started)", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    t.run.push({
      type: "event",
      event: "run.started",
      payload: { sessionKey: "s-root", model: "m" },
    })
    t.run.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.emitted).toContainEqual({
      type: "runner-started",
      runnerId: ROOT,
      model: "m",
    })
  })

  it("bridges exec.approval.requested through ctx.requestApproval and resolves the gateway", async () => {
    const t = setup("deny")
    await t.adapter.start(START, t.ctx)
    t.run.push({
      type: "event",
      event: "run.started",
      payload: { sessionKey: "s-root" },
    })
    t.run.push({
      type: "event",
      event: "exec.approval.requested",
      payload: {
        sessionKey: "s-root",
        approvalId: "a-1",
        kind: "command",
        detail: "rm",
      },
    })
    t.run.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.emitted).toContainEqual({
      type: "approval-requested",
      runnerId: ROOT,
      requestId: "apr_1",
      target: { kind: "command", detail: "rm" },
    })
    expect(t.run.resolved).toEqual([{ id: "a-1", decision: "deny" }])
  })

  it("handle.send forwards a follow-up turn; interrupt cancels the run; close disconnects", async () => {
    const t = setup()
    const handle = await t.adapter.start(START, t.ctx)
    handle.send("again")
    handle.interrupt()
    handle.close()
    expect(t.sentText).toBe("again")
    expect(t.run.cancelled).toBe(true)
    expect(t.run.closed).toBe(true)
    expect(t.disconnected).toBe(true)
  })

  it("accepts setThinkingEffort without throwing and does not disrupt a subsequent send", async () => {
    const t = setup()
    const handle = await t.adapter.start(START, t.ctx)
    expect(() => handle.setThinkingEffort?.("high")).not.toThrow()
    handle.send("after-effort")
    expect(t.sentText).toBe("after-effort")
  })

  it("emits exactly one approval-requested per gateway approval (no duplicate)", async () => {
    const t = setup("allow")
    await t.adapter.start(START, t.ctx)
    t.run.push({
      type: "event",
      event: "run.started",
      payload: { sessionKey: "s-root" },
    })
    t.run.push({
      type: "event",
      event: "exec.approval.requested",
      payload: {
        sessionKey: "s-root",
        approvalId: "a-1",
        kind: "command",
        detail: "rm",
      },
    })
    t.run.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(
      t.emitted.filter((e) => e.type === "approval-requested"),
    ).toHaveLength(1)
  })
})
