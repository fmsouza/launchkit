import { describe, expect, it } from "bun:test"
import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  CanonicalEvent,
  QuestionAnswer,
} from "@spectrum/agent-events"
import type { AdapterCtx } from "@spectrum/driver-runtime"
import type { RunnerId } from "@spectrum/types"
import type {
  AcpClient,
  AcpConfigOption,
  AcpConnect,
  AcpElicitation,
  AcpElicitationResponse,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpPromptCapabilities,
  AcpSessionUpdateNotification,
  AcpStopReason,
} from "./acp-client"
import { createAcpAdapter } from "./adapter"

const rid = (s: string): RunnerId => s as RunnerId

interface FakeClientOptions {
  readonly promptCapabilities?: AcpPromptCapabilities
  readonly availableModeIds?: readonly string[]
  readonly configOptions?: readonly AcpConfigOption[]
  readonly stopReason?: AcpStopReason
  readonly promptRejects?: boolean
}

/** A recording fake ACP client — unit-tests the adapter with no real agent spawn. */
interface FakeAcpClient extends AcpClient {
  permissionHandler:
    | ((req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>)
    | undefined
  elicitationHandler:
    | ((req: AcpElicitation) => Promise<AcpElicitationResponse>)
    | undefined
  updateHandler: ((notif: AcpSessionUpdateNotification) => void) | undefined
  readonly prompts: { sessionId: string; prompt: readonly AcpPromptBlock[] }[]
  readonly cancels: string[]
  readonly modes: { sessionId: string; modeId: string }[]
  readonly configCalls: {
    sessionId: string
    configId: string
    valueId: string
  }[]
  readonly sessionCloseCalls: string[]
  readonly inits: number
  readonly sessionNews: number
  readonly sessionLoads: readonly string[]
  /** Flush the microtasks the fire-and-forget prompt promise resolves through. */
  settle(): Promise<void>
}

const createFakeClient = (options: FakeClientOptions = {}): FakeAcpClient => {
  const prompts: { sessionId: string; prompt: readonly AcpPromptBlock[] }[] = []
  const cancels: string[] = []
  const modes: { sessionId: string; modeId: string }[] = []
  const configCalls: {
    sessionId: string
    configId: string
    valueId: string
  }[] = []
  const sessionCloseCalls: string[] = []
  const sessionLoads: string[] = []
  let inits = 0
  let sessionNews = 0
  const sessionInfo = {
    sessionId: "acp-sess-1",
    availableModeIds: options.availableModeIds ?? [],
    configOptions: options.configOptions ?? [],
  }
  const client: FakeAcpClient = {
    permissionHandler: undefined,
    elicitationHandler: undefined,
    updateHandler: undefined,
    prompts,
    cancels,
    modes,
    configCalls,
    sessionCloseCalls,
    get inits() {
      return inits
    },
    get sessionNews() {
      return sessionNews
    },
    get sessionLoads() {
      return sessionLoads
    },
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
    initialize: async () => {
      inits++
      return {
        promptCapabilities: options.promptCapabilities ?? {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      }
    },
    sessionNew: async () => {
      sessionNews++
      return sessionInfo
    },
    sessionLoad: async (id) => {
      sessionLoads.push(id)
      return sessionInfo
    },
    sessionPrompt: async (sid, prompt) => {
      prompts.push({ sessionId: sid, prompt: [...prompt] })
      if (options.promptRejects === true) throw new Error("transport died")
      return options.stopReason ?? "end_turn"
    },
    sessionCancel: (sid) => {
      cancels.push(sid)
    },
    sessionSetMode: (sid, modeId) => {
      modes.push({ sessionId: sid, modeId })
    },
    sessionSetConfigOption: (sid, configId, valueId) => {
      configCalls.push({ sessionId: sid, configId, valueId })
    },
    sessionClose: (sid) => {
      sessionCloseCalls.push(sid)
    },
    onSessionUpdate: (cb) => {
      client.updateHandler = cb
      return () => {
        client.updateHandler = undefined
      }
    },
    onPermissionRequest: (cb) => {
      client.permissionHandler = cb
    },
    onElicitationCreate: (cb) => {
      client.elicitationHandler = cb
    },
    close: () => {},
  }
  return client
}

interface FakeCtxOptions {
  readonly approval?: ApprovalDecision
  readonly questionAnswer?: QuestionAnswer
}

const createFakeCtx = (
  options: FakeCtxOptions = {},
): { ctx: AdapterCtx; events: CanonicalEvent[] } => {
  const events: CanonicalEvent[] = []
  let runnerCounter = 0
  let aprCounter = 0
  let qstCounter = 0
  const ctx: AdapterCtx = {
    emit: (e) => {
      events.push(e)
    },
    requestApproval: async (runnerId, target) => {
      const requestId = `apr_${aprCounter++}`
      events.push({ type: "approval-requested", runnerId, requestId, target })
      return options.approval ?? "allow"
    },
    requestQuestion: async (runnerId, prompt) => {
      const requestId = `qst_${qstCounter++}`
      events.push({ type: "question-requested", runnerId, requestId, prompt })
      return options.questionAnswer ?? { selections: [] }
    },
    newRunnerId: () => rid(`rnr_child_${runnerCounter++}`),
    rootRunnerId: rid("rnr_root"),
  }
  return { ctx, events }
}

const createFakeConnect = (client: FakeAcpClient): AcpConnect => {
  return async () => ({ client, close: () => {} })
}

const startInput = (
  overrides: Partial<AgentStartInput> = {},
): AgentStartInput =>
  ({
    harnessId: "claude" as never,
    cwd: "/tmp",
    env: {},
    command: "claude-code-acp",
    args: [],
    ...overrides,
  }) as AgentStartInput

const start = async (
  client: FakeAcpClient,
  ctxOptions: FakeCtxOptions = {},
  inputOverrides: Partial<AgentStartInput> = {},
) => {
  const { ctx, events } = createFakeCtx(ctxOptions)
  const adapter = createAcpAdapter({ connect: createFakeConnect(client) })
  const handle = await adapter.start(startInput(inputOverrides), ctx)
  return { handle, ctx, events }
}

describe("createAcpAdapter — start", () => {
  it("declares no static supportedModes (they are negotiated per session)", () => {
    const adapter = createAcpAdapter({
      connect: createFakeConnect(createFakeClient()),
    })
    expect(adapter.supportedModes).toBeUndefined()
  })

  it("initializes the ACP client and creates a new session on start", async () => {
    const client = createFakeClient()
    await start(client)
    expect(client.inits).toBe(1)
    expect(client.sessionNews).toBe(1)
  })

  it("loads an existing session when resume is provided", async () => {
    const client = createFakeClient()
    await start(client, {}, { resume: "acp-sess-prev" })
    expect(client.sessionLoads).toEqual(["acp-sess-prev"])
  })

  it("reports the resume token via ctx when setResumeId is wired", async () => {
    const client = createFakeClient()
    const { ctx } = createFakeCtx()
    let reportedToken: string | undefined
    ctx.reportResumeToken = (token) => {
      reportedToken = token
    }
    const adapter = createAcpAdapter({ connect: createFakeConnect(client) })
    await adapter.start(startInput({ sessionId: "s1" as never }), ctx)
    expect(reportedToken).toBe("acp-sess-1")
  })

  it("sends the initial prompt when provided", async () => {
    const client = createFakeClient()
    await start(client, {}, { initialPrompt: "hello" })
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.prompt).toEqual([{ type: "text", text: "hello" }])
  })

  it("emits runner-started carrying the modes the agent advertised", async () => {
    const client = createFakeClient({ availableModeIds: ["default", "plan"] })
    const { events } = await start(client)
    const started = events.find((e) => e.type === "runner-started")
    expect(started).toMatchObject({ supportedModes: ["manual", "plan"] })
  })

  it("emits runner-started with no supportedModes when the agent advertises none", async () => {
    const client = createFakeClient({ availableModeIds: [] })
    const { events } = await start(client)
    const started = events.find((e) => e.type === "runner-started")
    expect(started).toBeDefined()
    expect(
      (started as { supportedModes?: unknown }).supportedModes,
    ).toBeUndefined()
  })

  it("emits runner-started carrying the attachment kinds the agent accepts", async () => {
    const client = createFakeClient({
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    })
    const { events } = await start(client)
    const started = events.find((e) => e.type === "runner-started")
    expect(started).toMatchObject({
      supportedAttachments: { image: true, pdf: false, binary: false },
    })
  })
})

describe("createAcpAdapter — permission bridge", () => {
  it("answers a permission request with the option matching the user's decision", async () => {
    const client = createFakeClient()
    await start(client, { approval: "allow-always" })

    const outcome = await client.permissionHandler?.({
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "call_1", title: "rm -rf", kind: "execute" },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
      ],
    })

    expect(outcome).toEqual({ outcome: "selected", optionId: "always" })
  })

  it("answers with the reject option when the user denies", async () => {
    const client = createFakeClient()
    await start(client, { approval: "deny" })

    const outcome = await client.permissionHandler?.({
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "call_1" },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    })

    expect(outcome).toEqual({ outcome: "selected", optionId: "no" })
  })

  it("cancels the request when the agent offers no option matching the decision", async () => {
    const client = createFakeClient()
    await start(client, { approval: "deny" })

    const outcome = await client.permissionHandler?.({
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "call_1" },
      options: [],
    })

    expect(outcome).toEqual({ outcome: "cancelled" })
  })

  it("emits approval-requested with a command target for an execute tool call", async () => {
    const client = createFakeClient()
    const { events } = await start(client)

    await client.permissionHandler?.({
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "call_1", title: "npm test", kind: "execute" },
      options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
    })

    expect(events.find((e) => e.type === "approval-requested")).toMatchObject({
      target: { kind: "command", detail: "npm test" },
    })
  })
})

describe("createAcpAdapter — elicitation bridge", () => {
  it("answers an elicitation request with the user's answer", async () => {
    const client = createFakeClient()
    await start(client, {
      questionAnswer: { selections: [{ questionIndex: 0, labels: ["main"] }] },
    })

    const response = await client.elicitationHandler?.({
      message: "Which branch?",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string", enum: ["main", "dev"] } },
      },
    })

    expect(response).toEqual({ action: "accept", content: { branch: "main" } })
  })

  it("declines the elicitation when the user answers nothing", async () => {
    const client = createFakeClient()
    await start(client, { questionAnswer: { selections: [] } })

    const response = await client.elicitationHandler?.({ message: "Which?" })

    expect(response).toEqual({ action: "decline" })
  })

  it("emits question-requested carrying the elicitation message", async () => {
    const client = createFakeClient()
    const { events } = await start(client)

    await client.elicitationHandler?.({ message: "Which branch?" })

    const question = events.find((e) => e.type === "question-requested")
    expect(question).toMatchObject({
      prompt: { questions: [{ question: "Which branch?" }] },
    })
  })
})

describe("createAcpAdapter — handle", () => {
  it("send fires sessionPrompt with text content", async () => {
    const client = createFakeClient()
    const { handle } = await start(client)
    handle.send({ text: "do something" })
    expect(client.prompts.at(-1)?.prompt).toEqual([
      { type: "text", text: "do something" },
    ])
  })

  it("interrupt fires sessionCancel", async () => {
    const client = createFakeClient()
    const { handle } = await start(client)
    handle.interrupt()
    expect(client.cancels).toEqual(["acp-sess-1"])
  })

  it("setMode fires sessionSetMode with the agent's own mode id", async () => {
    const client = createFakeClient({
      availableModeIds: ["default", "bypassPermissions"],
    })
    const { handle } = await start(client)
    handle.setMode?.("bypass")
    expect(client.modes).toEqual([
      { sessionId: "acp-sess-1", modeId: "bypassPermissions" },
    ])
  })

  it("setMode does nothing when the agent cannot honor the mode", async () => {
    const client = createFakeClient({ availableModeIds: ["default"] })
    const { handle } = await start(client)
    handle.setMode?.("plan")
    expect(client.modes).toEqual([])
  })

  it("close closes the session and the connection", async () => {
    const client = createFakeClient()
    const { handle } = await start(client)
    handle.close()
    expect(client.sessionCloseCalls).toContain("acp-sess-1")
  })
})

describe("createAcpAdapter — session/update streaming", () => {
  it("maps an agent_message_chunk to a text-delta event via ctx.emit", async () => {
    const client = createFakeClient()
    const { events } = await start(client)
    client.updateHandler?.({
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hi" },
      },
    })
    expect(events.find((e) => e.type === "text-delta")).toMatchObject({
      messageId: "m1",
      text: "hi",
    })
  })

  it("maps an agent_thought_chunk to a reasoning-delta event", async () => {
    const client = createFakeClient()
    const { events } = await start(client)
    client.updateHandler?.({
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "m2",
        content: { type: "text", text: "thinking" },
      },
    })
    expect(events.find((e) => e.type === "reasoning-delta")).toMatchObject({
      messageId: "m2",
      text: "thinking",
    })
  })
})
