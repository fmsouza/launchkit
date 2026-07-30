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
  /** Hold session/set_mode open until `releaseSetMode()` so ordering can be observed. */
  readonly blockSetMode?: boolean
  readonly rejectSetMode?: boolean
  readonly rejectSessionLoad?: boolean
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
  /** Every mutating call in the order the adapter made it. */
  readonly callOrder: readonly string[]
  /** Flush the microtasks the fire-and-forget prompt promise resolves through. */
  settle(): Promise<void>
  releaseSetMode(): void
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
  const callOrder: string[] = []
  let releaseSetMode: () => void = () => {}
  const setModeGate =
    options.blockSetMode === true
      ? new Promise<void>((resolve) => {
          releaseSetMode = resolve
        })
      : Promise.resolve()
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
    callOrder,
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
    releaseSetMode: () => {
      releaseSetMode()
    },
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
      if (options.rejectSessionLoad === true)
        throw new Error("no rollout found for thread id")
      return sessionInfo
    },
    sessionPrompt: async (sid, prompt) => {
      callOrder.push("prompt")
      prompts.push({ sessionId: sid, prompt: [...prompt] })
      if (options.promptRejects === true) throw new Error("transport died")
      return options.stopReason ?? "end_turn"
    },
    sessionCancel: async (sid) => {
      cancels.push(sid)
    },
    sessionSetMode: async (sid, modeId) => {
      callOrder.push("setMode")
      modes.push({ sessionId: sid, modeId })
      await setModeGate
      if (options.rejectSetMode === true) throw new Error("mode not accepted")
    },
    sessionSetConfigOption: async (sid, configId, valueId) => {
      callOrder.push("setConfigOption")
      configCalls.push({ sessionId: sid, configId, valueId })
    },
    sessionClose: async (sid) => {
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

  it("starts a fresh session when the agent cannot resume the old one", async () => {
    // Spectrum captures the resume token at session CREATION, so a session the user never
    // prompted has no transcript for the agent to reload — codex answers "no rollout found for
    // thread id". Failing the run over that would strand the user on a session they can still
    // use; fall back to a fresh session instead.
    const client = createFakeClient({ rejectSessionLoad: true })
    const { events } = await start(client, {}, { resume: "acp-sess-gone" })
    expect(client.sessionLoads).toEqual(["acp-sess-gone"])
    expect(client.sessionNews).toBe(1)
    expect(events.some((e) => e.type === "runner-started")).toBe(true)
  })

  it("reports the fresh session id when a resume falls back", async () => {
    const client = createFakeClient({ rejectSessionLoad: true })
    const { ctx } = createFakeCtx()
    let reported: string | undefined
    ctx.reportResumeToken = (t) => {
      reported = t
    }
    const adapter = createAcpAdapter({ connect: createFakeConnect(client) })
    await adapter.start(startInput({ resume: "acp-sess-gone" }), ctx)
    expect(reported).toBe("acp-sess-1")
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

describe("createAcpAdapter — initial permission mode", () => {
  it("applies the run's permission mode at session start", async () => {
    const client = createFakeClient({
      availableModeIds: ["default", "acceptEdits", "plan", "bypassPermissions"],
    })
    await start(client, {}, { permissionMode: "plan" })
    expect(client.modes).toEqual([{ sessionId: "acp-sess-1", modeId: "plan" }])
  })

  it("defaults to manual when the run carries no permission mode", async () => {
    // claude-agent-acp starts a session in `bypassPermissions` — every tool call auto-approved and
    // the permission callback never consulted. Spectrum's default has always been ask-me, so the
    // adapter must set it rather than inherit whatever the agent chose.
    const client = createFakeClient({
      availableModeIds: ["default", "acceptEdits", "plan", "bypassPermissions"],
    })
    await start(client)
    expect(client.modes).toEqual([
      { sessionId: "acp-sess-1", modeId: "default" },
    ])
  })

  it("waits for the mode to land before firing the initial prompt", async () => {
    // Merely CALLING set_mode first is not enough: it is a request, and the agent applies the mode
    // when it resolves. claude-agent-acp ran an entire first turn in its own default mode
    // (bypassPermissions — every tool auto-approved) because the prompt overtook it.
    const client = createFakeClient({
      availableModeIds: ["default", "acceptEdits", "plan", "bypassPermissions"],
      blockSetMode: true,
    })
    const startPromise = start(
      client,
      {},
      { permissionMode: "plan", initialPrompt: "go" },
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(client.prompts).toHaveLength(0) // still waiting on set_mode

    client.releaseSetMode()
    await startPromise
    await client.settle()
    expect(client.prompts).toHaveLength(1)
    expect(client.callOrder).toEqual(["setMode", "prompt"])
  })

  it("still fires the initial prompt when the agent rejects the mode change", async () => {
    // A mode the agent will not accept must not strand the turn.
    const client = createFakeClient({
      availableModeIds: ["default", "plan"],
      rejectSetMode: true,
    })
    await start(client, {}, { permissionMode: "plan", initialPrompt: "go" })
    await client.settle()
    expect(client.prompts).toHaveLength(1)
  })

  it("does not set a mode when the agent advertises none", async () => {
    const client = createFakeClient({ availableModeIds: [] })
    await start(client, {}, { permissionMode: "plan" })
    expect(client.modes).toEqual([])
    expect(client.configCalls).toEqual([])
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
    client.modes.length = 0 // drop the start-time mode; assert the switch alone
    handle.setMode?.("bypass")
    expect(client.modes).toEqual([
      { sessionId: "acp-sess-1", modeId: "bypassPermissions" },
    ])
  })

  it("setMode does nothing when the agent cannot honor the mode", async () => {
    const client = createFakeClient({ availableModeIds: ["default"] })
    const { handle } = await start(client)
    client.modes.length = 0
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

describe("createAcpAdapter — turn outcomes", () => {
  it("emits a plain turn-finished when the agent stops with end_turn", async () => {
    const client = createFakeClient({ stopReason: "end_turn" })
    const { handle, ctx, events } = await start(client)
    handle.send({ text: "hi" })
    // A real end_turn turn produces something; an empty one is reported as an error instead
    // (see "silent turns").
    client.updateHandler?.({
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hi back" },
      },
    })
    await client.settle()
    expect(events.at(-1)).toEqual({
      type: "turn-finished",
      runnerId: ctx.rootRunnerId,
    })
  })

  it("emits a plain turn-finished when the turn was cancelled by the user", async () => {
    const client = createFakeClient({ stopReason: "cancelled" })
    const { handle, ctx, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toEqual({
      type: "turn-finished",
      runnerId: ctx.rootRunnerId,
    })
  })

  it("emits turn-finished with an error when the agent refuses", async () => {
    const client = createFakeClient({ stopReason: "refusal" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      type: "turn-finished",
      error: { detail: "the agent refused to continue" },
    })
  })

  it("emits turn-finished with an error when the agent hits its token limit", async () => {
    const client = createFakeClient({ stopReason: "max_tokens" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      type: "turn-finished",
      error: { detail: "the turn stopped at the model's token limit" },
    })
  })

  it("emits turn-finished with an error when the agent hits its request limit", async () => {
    const client = createFakeClient({ stopReason: "max_turn_requests" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      type: "turn-finished",
      error: { detail: "the turn stopped at the agent's request limit" },
    })
  })

  it("emits turn-finished with an error when the prompt itself fails", async () => {
    const client = createFakeClient({ promptRejects: true })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      type: "turn-finished",
      error: { detail: expect.stringContaining("transport died") },
    })
  })
})

describe("createAcpAdapter — silent turns", () => {
  it("reports an error when a turn ends having produced nothing at all", async () => {
    // Observed live: an OpenClaw session whose gateway had no provider auth answered
    // `stopReason: end_turn` with no content, so the user saw a successful-looking empty turn and
    // no explanation. A turn that produced no text, no reasoning and no tool call did not work.
    const client = createFakeClient({ stopReason: "end_turn" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      type: "turn-finished",
      error: {
        detail: "the agent finished the turn without producing any output",
      },
    })
  })

  it("does not report an error when the turn produced assistant text", async () => {
    const client = createFakeClient({ stopReason: "end_turn" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    client.updateHandler?.({
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hello" },
      },
    })
    await client.settle()
    expect(events.at(-1)).not.toMatchObject({ error: expect.anything() })
  })

  it("does not report an error when the turn only ran a tool", async () => {
    const client = createFakeClient({ stopReason: "end_turn" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    client.updateHandler?.({
      sessionId: "acp-sess-1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" },
    })
    await client.settle()
    expect(events.at(-1)).not.toMatchObject({ error: expect.anything() })
  })

  it("keeps the agent's own error when the turn ends abnormally and empty", async () => {
    const client = createFakeClient({ stopReason: "refusal" })
    const { handle, events } = await start(client)
    handle.send({ text: "hi" })
    await client.settle()
    expect(events.at(-1)).toMatchObject({
      error: { detail: "the agent refused to continue" },
    })
  })
})

describe("createAcpAdapter — attachments", () => {
  const png = {
    id: "sha_1",
    mime: "image/png",
    displayName: "a.png",
    kind: "image" as const,
    bytes: 3,
    dataUrl: "data:image/png;base64,AAAA",
  }

  it("sends attachments as ACP content blocks alongside the text", async () => {
    const client = createFakeClient({
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    })
    const { handle } = await start(client)
    handle.send({ text: "look", attachments: [png] })
    expect(client.prompts.at(-1)?.prompt).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ])
  })

  it("drops attachments the agent did not advertise support for", async () => {
    const client = createFakeClient({
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
    })
    const { handle } = await start(client)
    handle.send({ text: "look", attachments: [png] })
    expect(client.prompts.at(-1)?.prompt).toEqual([
      { type: "text", text: "look" },
    ])
  })

  it("does not fire a prompt for an empty turn with no attachments", async () => {
    const client = createFakeClient()
    const { handle } = await start(client)
    handle.send({ text: "" })
    expect(client.prompts).toHaveLength(0)
  })
})

describe("createAcpAdapter — session config options", () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    values: [{ id: "opus", name: "Opus" }],
  }
  const effortOption = {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    values: [{ id: "high", name: "High" }],
  }
  const modeOption = {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    values: [
      { id: "build", name: "build" },
      { id: "plan", name: "plan" },
    ],
  }

  it("switches the model via session/set_config_option when the agent advertises one", async () => {
    const client = createFakeClient({ configOptions: [modelOption] })
    const { handle } = await start(client)
    handle.setModel?.("opus" as never)
    expect(client.configCalls).toEqual([
      { sessionId: "acp-sess-1", configId: "model", valueId: "opus" },
    ])
  })

  it("does nothing on setModel when the agent advertises no model option", async () => {
    const client = createFakeClient({ configOptions: [] })
    const { handle } = await start(client)
    handle.setModel?.("opus" as never)
    expect(client.configCalls).toEqual([])
  })

  it("does nothing on setModel when the model is cleared to the harness default", async () => {
    const client = createFakeClient({ configOptions: [modelOption] })
    const { handle } = await start(client)
    handle.setModel?.(null)
    expect(client.configCalls).toEqual([])
  })

  it("switches the thinking effort via session/set_config_option when advertised", async () => {
    const client = createFakeClient({ configOptions: [effortOption] })
    const { handle } = await start(client)
    handle.setThinkingEffort?.("high")
    expect(client.configCalls).toEqual([
      {
        sessionId: "acp-sess-1",
        configId: "reasoning_effort",
        valueId: "high",
      },
    ])
  })

  it("does nothing on setThinkingEffort when the agent advertises no effort option", async () => {
    const client = createFakeClient({ configOptions: [modelOption] })
    const { handle } = await start(client)
    handle.setThinkingEffort?.("high")
    expect(client.configCalls).toEqual([])
  })

  it("reports modes advertised as a config option rather than via session/new", async () => {
    // opencode advertises build/plan as a `category: "mode"` config option and leaves
    // session/new's `modes` empty — verified against a live `opencode acp` process.
    const client = createFakeClient({
      availableModeIds: [],
      configOptions: [modeOption],
    })
    const { events } = await start(client)
    const started = events.find((e) => e.type === "runner-started")
    expect(started).toMatchObject({ supportedModes: ["manual", "plan"] })
  })

  it("switches a config-option mode via session/set_config_option", async () => {
    const client = createFakeClient({
      availableModeIds: [],
      configOptions: [modeOption],
    })
    const { handle } = await start(client)
    client.configCalls.length = 0 // drop the start-time mode; assert the switch alone
    handle.setMode?.("plan")
    expect(client.configCalls).toEqual([
      { sessionId: "acp-sess-1", configId: "mode", valueId: "plan" },
    ])
    expect(client.modes).toEqual([])
  })

  it("prefers session/set_mode when the agent advertises real session modes", async () => {
    const client = createFakeClient({
      availableModeIds: ["default", "plan"],
      configOptions: [modeOption],
    })
    const { handle } = await start(client)
    client.modes.length = 0
    handle.setMode?.("plan")
    expect(client.modes).toEqual([{ sessionId: "acp-sess-1", modeId: "plan" }])
    expect(client.configCalls).toEqual([])
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
