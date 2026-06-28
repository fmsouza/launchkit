import { describe, expect, it } from "bun:test"
import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  PermissionMode,
  RunnerId,
} from "@spectrum/agent-events"
import { OPENCODE_SUPPORTED_MODES, createOpencodeAdapter } from "./adapter"
import { S_ROOT } from "./fixtures/opencode-events"
import type {
  OpencodeClient,
  OpencodeConnectConfig,
  OpencodeEvent,
  OpencodeEventStream,
} from "./transport"

const ROOT = "rnr_root" as RunnerId

const START: AgentStartInput = {
  harnessId: "opencode" as never,
  cwd: "/work",
  env: {},
  initialPrompt: "do the thing",
}

// A controllable fake event stream: push events, then end.
class FakeStream implements OpencodeEventStream {
  private readonly queue: OpencodeEvent[] = []
  private done = false
  private wake: (() => void) | undefined
  push(e: OpencodeEvent): void {
    this.queue.push(e)
    this.wake?.()
  }
  end(): void {
    this.done = true
    this.wake?.()
  }
  get stream(): AsyncIterable<OpencodeEvent> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.queue.length > 0) {
            const next = self.queue.shift()
            if (next !== undefined) yield next
          }
          if (self.done) return
          await new Promise<void>((r) => {
            self.wake = r
          })
        }
      },
    }
  }
}

const setup = (decision: ApprovalDecision = "allow") => {
  const emitted: CanonicalEvent[] = []
  const fakeStream = new FakeStream()
  const prompts: Array<{ id: string; text: string }> = []
  const aborts: string[] = []
  const replies: Array<{ id: string; permissionID: string; response: string }> =
    []
  let createdParent: string | undefined
  let serverClosed = false
  let connectCfg: OpencodeConnectConfig | undefined

  const client: OpencodeClient = {
    session: {
      create: async ({ body }) => {
        createdParent = body.parentID
        return { id: S_ROOT }
      },
      prompt: async ({ path, body }) => {
        prompts.push({
          id: path.id,
          text: body.parts.map((p) => p.text).join(""),
        })
      },
      abort: async ({ path }) => {
        aborts.push(path.id)
      },
      permissions: async ({ path, body }) => {
        replies.push({
          id: path.id,
          permissionID: path.permissionID,
          response: body.response,
        })
      },
    },
    event: { subscribe: async () => fakeStream },
  }

  let aprSeq = 0
  const ctx = {
    rootRunnerId: ROOT,
    emit: (e: CanonicalEvent) => emitted.push(e),
    newRunnerId: (): RunnerId => "rnr_child" as RunnerId,
    /**
     * Mirror the real runtime's ctx.requestApproval: emit an approval-requested with a
     * minted apr_* requestId THEN resolve to the configured decision.  This is the
     * regression guard — previously the fake silently swallowed the emit, hiding the
     * duplicate that the mapper was also producing.
     */
    requestApproval: async (
      r: RunnerId,
      t: ApprovalTarget,
    ): Promise<ApprovalDecision> => {
      const requestId = `apr_${++aprSeq}`
      emitted.push({
        type: "approval-requested",
        runnerId: r,
        requestId,
        target: t,
      })
      return decision
    },
  }

  const adapter = createOpencodeAdapter({
    connect: async (config) => {
      connectCfg = config
      return {
        client,
        server: {
          url: "http://127.0.0.1:4096",
          close: () => {
            serverClosed = true
          },
        },
      }
    },
    // No-op watchdog for the deterministic tests (timeout path covered separately).
    watchdogMs: 0,
  })

  return {
    adapter,
    ctx,
    fakeStream,
    emitted,
    prompts,
    aborts,
    replies,
    get createdParent() {
      return createdParent
    },
    get serverClosed() {
      return serverClosed
    },
    get connectCfg() {
      return connectCfg
    },
  }
}

/**
 * Extended setup for permission-mode tests: captures full prompt bodies (including `agent`)
 * and counts `requestApproval` calls.
 */
const setupMode = (
  permissionMode: PermissionMode,
  decision: ApprovalDecision = "allow",
) => {
  const emitted: CanonicalEvent[] = []
  const fakeStream = new FakeStream()
  const promptBodies: Array<{
    id: string
    parts: ReadonlyArray<{ type: "text"; text: string }>
    agent?: string
  }> = []
  const replies: Array<{ id: string; permissionID: string; response: string }> =
    []
  let approvalCallCount = 0

  const client: OpencodeClient = {
    session: {
      create: async () => ({ id: S_ROOT }),
      prompt: async ({ path, body }) => {
        promptBodies.push({ id: path.id, parts: body.parts, agent: body.agent })
      },
      abort: async () => {},
      permissions: async ({ path, body }) => {
        replies.push({
          id: path.id,
          permissionID: path.permissionID,
          response: body.response,
        })
      },
    },
    event: { subscribe: async () => fakeStream },
  }

  const ctx = {
    rootRunnerId: ROOT,
    emit: (e: CanonicalEvent) => emitted.push(e),
    newRunnerId: (): RunnerId => "rnr_child" as RunnerId,
    requestApproval: async (
      _r: RunnerId,
      _t: ApprovalTarget,
    ): Promise<ApprovalDecision> => {
      approvalCallCount++
      return decision
    },
  }

  const startInput = (
    override?: Partial<AgentStartInput>,
  ): AgentStartInput => ({
    harnessId: "opencode" as never,
    cwd: "/work",
    env: {},
    initialPrompt: "init",
    permissionMode,
    ...override,
  })

  const adapter = createOpencodeAdapter({
    connect: async () => ({
      client,
      server: { url: "http://127.0.0.1:4096", close: () => {} },
    }),
    watchdogMs: 0,
  })

  return {
    adapter,
    ctx,
    fakeStream,
    emitted,
    promptBodies,
    replies,
    startInput,
    get approvalCallCount() {
      return approvalCallCount
    },
  }
}

describe("createOpencodeAdapter", () => {
  it("connects with cwd from AgentStartInput, creates a root session (no parentID), and emits root runner-started", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    expect(t.connectCfg).toMatchObject({ cwd: "/work" })
    expect(t.createdParent).toBeUndefined()
    expect(t.emitted).toContainEqual({ type: "runner-started", runnerId: ROOT })
  })

  it("passes a spectrum proxy provider config to connect when the proxy env is present", async () => {
    const t = setup()
    await t.adapter.start(
      {
        ...START,
        env: {
          OPENAI_BASE_URL: "http://127.0.0.1:4000/v1",
          OPENAI_API_KEY: "rk_1",
          OPENAI_MODEL: "minimax-m3",
        },
      },
      t.ctx,
    )
    expect(t.connectCfg?.config).toEqual({
      provider: {
        spectrum: {
          npm: "@ai-sdk/openai-compatible",
          name: "Spectrum",
          options: { baseURL: "http://127.0.0.1:4000/v1", apiKey: "rk_1" },
          models: { "minimax-m3": {} },
        },
      },
      model: "spectrum/minimax-m3",
    })
  })

  it("omits the proxy config on the direct route (no proxy env)", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    expect(t.connectCfg?.config).toBeUndefined()
  })

  it("sends the initial prompt to the root session via session.prompt", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    expect(t.prompts).toContainEqual({ id: S_ROOT, text: "do the thing" })
  })

  it("emits mapped canonical events from the (filtered) global stream", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    t.fakeStream.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p",
          sessionID: S_ROOT,
          messageID: "m",
          type: "text",
          text: "hi",
        },
      },
    })
    t.fakeStream.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.emitted).toContainEqual({
      type: "text-delta",
      runnerId: ROOT,
      messageId: "m",
      text: "hi",
    })
  })

  it("filters out events for an unrelated session", async () => {
    const t = setup()
    await t.adapter.start(START, t.ctx)
    t.fakeStream.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p",
          sessionID: "ses_other",
          messageID: "m",
          type: "text",
          text: "nope",
        },
      },
    })
    t.fakeStream.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.emitted.some((e) => e.type === "text-delta")).toBe(false)
  })

  it("bridges permission.updated through ctx.requestApproval and replies (allow -> once)", async () => {
    const t = setup("allow")
    await t.adapter.start(START, t.ctx)
    t.fakeStream.push({
      type: "permission.updated",
      properties: {
        id: "perm_1",
        type: "bash",
        sessionID: S_ROOT,
        title: "t",
        pattern: "rm",
      },
    })
    t.fakeStream.end()
    await new Promise((r) => setTimeout(r, 0))
    // approval-requested comes from the runtime bridge (ctx.requestApproval), NOT from the mapper.
    // The runtime mints its own apr_* requestId; perm_1 is the opencode id used only for the REST reply.
    expect(t.emitted).toContainEqual({
      type: "approval-requested",
      runnerId: ROOT,
      requestId: "apr_1",
      target: { kind: "command", detail: "rm" },
    })
    expect(t.replies).toEqual([
      { id: S_ROOT, permissionID: "perm_1", response: "once" },
    ])
  })

  it("emits exactly one approval-requested per permission (no duplicate)", async () => {
    const t = setup("allow")
    await t.adapter.start(START, t.ctx)
    t.fakeStream.push({
      type: "permission.updated",
      properties: {
        id: "perm_1",
        type: "bash",
        sessionID: S_ROOT,
        title: "t",
        pattern: "rm",
      },
    })
    t.fakeStream.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(
      t.emitted.filter((e) => e.type === "approval-requested"),
    ).toHaveLength(1)
  })

  it("handle.send prompts; interrupt aborts; close stops the server", async () => {
    const t = setup()
    const handle = await t.adapter.start(START, t.ctx)
    handle.send("again")
    handle.interrupt()
    handle.close()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.prompts).toContainEqual({ id: S_ROOT, text: "again" })
    expect(t.aborts).toContain(S_ROOT)
    expect(t.serverClosed).toBe(true)
  })

  // --- Permission-mode tests ---

  it("supportedModes equals OPENCODE_SUPPORTED_MODES constant", () => {
    const t = setup()
    expect(t.adapter.supportedModes).toEqual(OPENCODE_SUPPORTED_MODES)
  })

  it("replies always to permissions without asking when mode is bypass", async () => {
    const t = setupMode("bypass")
    await t.adapter.start(t.startInput(), t.ctx)
    t.fakeStream.push({
      type: "permission.updated",
      properties: {
        id: "perm_bypass",
        type: "bash",
        sessionID: S_ROOT,
        title: "t",
        pattern: "rm",
      },
    })
    t.fakeStream.end()
    await new Promise((r) => setTimeout(r, 0))
    // Replied always without user approval
    expect(t.replies).toEqual([
      { id: S_ROOT, permissionID: "perm_bypass", response: "always" },
    ])
    // requestApproval must NOT have been called
    expect(t.approvalCallCount).toBe(0)
    // No approval-requested event in the canonical stream
    expect(t.emitted.some((e) => e.type === "approval-requested")).toBe(false)
  })

  it("sends prompts with the plan agent when mode is plan", async () => {
    const t = setupMode("plan")
    const handle = await t.adapter.start(
      t.startInput({ initialPrompt: "init-plan" }),
      t.ctx,
    )
    handle.send("go")
    await new Promise((r) => setTimeout(r, 0))
    // Initial prompt carries agent: "plan"
    expect(t.promptBodies).toContainEqual({
      id: S_ROOT,
      parts: [{ type: "text", text: "init-plan" }],
      agent: "plan",
    })
    // handle.send also carries agent: "plan"
    expect(t.promptBodies).toContainEqual({
      id: S_ROOT,
      parts: [{ type: "text", text: "go" }],
      agent: "plan",
    })
  })

  it("switches behavior after setMode", async () => {
    // Start manual: prompt has no agent field
    const t = setupMode("manual")
    const handle = await t.adapter.start(
      t.startInput({ initialPrompt: "first" }),
      t.ctx,
    )
    // Switch to plan
    handle.setMode?.("plan")
    handle.send("second")
    await new Promise((r) => setTimeout(r, 0))
    // first prompt: no agent
    expect(t.promptBodies[0]).toEqual({
      id: S_ROOT,
      parts: [{ type: "text", text: "first" }],
      agent: undefined,
    })
    // second prompt: agent: "plan"
    expect(t.promptBodies[1]).toEqual({
      id: S_ROOT,
      parts: [{ type: "text", text: "second" }],
      agent: "plan",
    })
  })

  it("fires the #6573 watchdog: finishes the root errored + closes the server when no session.idle arrives", async () => {
    // Use a manual timer so the test is deterministic (no real delay).
    let fire: (() => void) | undefined
    const t = (() => {
      const emitted: CanonicalEvent[] = []
      const fakeStream = new FakeStream()
      let serverClosed = false
      const client: OpencodeClient = {
        session: {
          create: async () => ({ id: S_ROOT }),
          prompt: async () => {},
          abort: async () => {},
          permissions: async () => {},
        },
        event: { subscribe: async () => fakeStream },
      }
      const ctx = {
        rootRunnerId: ROOT,
        emit: (e: CanonicalEvent) => emitted.push(e),
        newRunnerId: (): RunnerId => "rnr_child" as RunnerId,
        requestApproval: async (): Promise<ApprovalDecision> => "allow",
      }
      const adapter = createOpencodeAdapter({
        connect: async () => ({
          client,
          server: {
            url: "u",
            close: () => {
              serverClosed = true
            },
          },
        }),
        watchdogMs: 5,
        setTimer: (fn) => {
          fire = fn
          return 0 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: () => {},
      })
      return {
        adapter,
        ctx,
        fakeStream,
        emitted,
        get serverClosed() {
          return serverClosed
        },
      }
    })()
    await t.adapter.start(START, t.ctx) // arms the watchdog (initialPrompt present)
    fire?.()
    expect(
      t.emitted.some(
        (e) => e.type === "runner-finished" && e.status === "errored",
      ),
    ).toBe(true)
    expect(t.serverClosed).toBe(true)
  })

  // --- setModel: fresh server restart ---------------------------------------------------

  it("accepts setThinkingEffort without throwing and does not disrupt a subsequent send", async () => {
    const t = setup()
    const handle = await t.adapter.start(START, t.ctx)
    expect(() => handle.setThinkingEffort?.("high")).not.toThrow()
    handle.send("after-effort")
    await new Promise((r) => setTimeout(r, 0))
    expect(t.prompts).toContainEqual({ id: S_ROOT, text: "after-effort" })
  })

  it("setModel restarts the server with the new model, closes the old server, and re-emits runner-started with the new model", async () => {
    // Custom fake-connect: each call records its config + returns a fresh server + a fresh client
    // whose session.create returns a distinct session id, so we can prove the new session was created.
    const connectConfigs: OpencodeConnectConfig[] = []
    const serverCloses: number[] = []
    const createdSessionIds: string[] = []
    let nextSessionSeq = 0
    const nextSessionId = (): string => `ses_${++nextSessionSeq}`

    const buildClient = (): OpencodeClient => {
      const sid = nextSessionId()
      return {
        session: {
          create: async () => {
            createdSessionIds.push(sid)
            return { id: sid }
          },
          prompt: async () => {},
          abort: async () => {},
          permissions: async () => {},
        },
        event: { subscribe: async () => new FakeStream() },
      }
    }

    const emitted: CanonicalEvent[] = []
    const ctx = {
      rootRunnerId: ROOT,
      emit: (e: CanonicalEvent) => emitted.push(e),
      newRunnerId: (): RunnerId => "rnr_child" as RunnerId,
      requestApproval: async (): Promise<ApprovalDecision> => "allow",
    }

    const adapter = createOpencodeAdapter({
      connect: async (cfg) => {
        connectConfigs.push(cfg)
        const idx = serverCloses.length
        return {
          client: buildClient(),
          server: {
            url: "u",
            close: () => {
              serverCloses.push(idx)
            },
          },
        }
      },
      watchdogMs: 0,
    })

    const handle = await adapter.start(
      {
        ...START,
        env: {
          OPENAI_BASE_URL: "http://127.0.0.1:4000/v1",
          OPENAI_API_KEY: "rk_1",
          OPENAI_MODEL: "minimax-m3",
        },
      },
      ctx,
    )

    // First connect happened with the initial model.
    expect(connectConfigs).toHaveLength(1)
    expect(connectConfigs[0]?.config?.model).toBe("spectrum/minimax-m3")
    expect(connectConfigs[0]?.config?.provider.spectrum.models).toEqual({
      "minimax-m3": {},
    })
    expect(createdSessionIds).toEqual(["ses_1"])
    // First runner-started emitted on initial start.
    expect(emitted).toContainEqual({
      type: "runner-started",
      runnerId: ROOT,
    })

    // Now flip the model.
    handle.setModel?.("mdl_new" as never)
    // setModel is synchronous (it tears down + triggers a new connectAndRun); allow the restart.
    await new Promise((r) => setTimeout(r, 0))

    // (a) connect was called again with a config whose model reflects mdl_new.
    expect(connectConfigs).toHaveLength(2)
    expect(connectConfigs[1]?.config?.model).toBe("spectrum/mdl_new")
    expect(connectConfigs[1]?.config?.provider.spectrum.models).toEqual({
      mdl_new: {},
    })
    // (b) a new session was created.
    expect(createdSessionIds).toEqual(["ses_1", "ses_2"])
    // (c) runner-started re-emitted with the new model.
    const startedWithModel = emitted.filter(
      (e) =>
        e.type === "runner-started" && "model" in e && e.model === "mdl_new",
    )
    expect(startedWithModel).toHaveLength(1)
    expect(startedWithModel[0]?.runnerId).toBe(ROOT)
    // (d) the first server was close()d.
    expect(serverCloses).toEqual([0])

    // Tear down so we don't leak timers / async work.
    handle.close()
    await new Promise((r) => setTimeout(r, 0))
  })
})
