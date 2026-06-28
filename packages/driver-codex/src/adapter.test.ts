import { describe, expect, it } from "bun:test"
import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  CanonicalEvent,
  QuestionAnswer,
  QuestionPrompt,
  RunnerId,
} from "@spectrum/agent-events"
import type { AdapterCtx } from "@spectrum/driver-runtime"
import { createSequentialIdGen } from "@spectrum/utils"
import { type CreateCodexAdapterDeps, createCodexAdapter } from "./adapter"
import type {
  JsonRpcTransport,
  NotificationFrame,
  ServerRequestFrame,
} from "./transport"

const root = "rnr_root" as RunnerId

type OutgoingCall = ["request", string, unknown] | ["notify", string, unknown]
type Reply = { id: string | number; result?: unknown; error?: unknown }

type CreateTransportDeps = Parameters<
  NonNullable<CreateCodexAdapterDeps["createTransport"]>
>[0]

interface FakeTransport {
  readonly transport: JsonRpcTransport
  readonly outgoing: OutgoingCall[]
  readonly replies: Reply[]
  pushNotification(n: NotificationFrame): void
  pushServerRequest(r: ServerRequestFrame): void
  closed(): boolean
  setResult(method: string, result: unknown): void
  setReject(method: string, message: string): void
  createDeps(): CreateTransportDeps | undefined
}

/** A fake JsonRpcTransport that records outgoing calls + lets the test push server frames. */
const makeFakeTransport = (): {
  fake: FakeTransport
  factory: NonNullable<CreateCodexAdapterDeps["createTransport"]>
} => {
  const outgoing: OutgoingCall[] = []
  const replies: Reply[] = []
  const results = new Map<string, unknown>()
  const rejects = new Map<string, string>()
  let isClosed = false
  let onNotification: ((n: NotificationFrame) => void) | undefined
  let onServerRequest: ((r: ServerRequestFrame) => void) | undefined
  let createDeps: CreateTransportDeps | undefined

  const transport: JsonRpcTransport = {
    dispatcher: {
      request: (method, params) => {
        outgoing.push(["request", method, params])
        const rejectMsg = rejects.get(method)
        if (rejectMsg !== undefined) return Promise.reject(new Error(rejectMsg))
        return Promise.resolve(results.get(method))
      },
      notify: (method, params) => {
        outgoing.push(["notify", method, params])
      },
      respond: (id, result) => {
        replies.push({ id, result })
      },
      respondError: (id, code, message) => {
        replies.push({ id, error: { code, message } })
      },
      feed: () => {},
      rejectAll: () => {},
    },
    close: () => {
      isClosed = true
    },
  }

  const fake: FakeTransport = {
    transport,
    outgoing,
    replies,
    pushNotification: (n) => onNotification?.(n),
    pushServerRequest: (r) => onServerRequest?.(r),
    closed: () => isClosed,
    setResult: (method, result) => results.set(method, result),
    setReject: (method, message) => rejects.set(method, message),
    createDeps: () => createDeps,
  }

  const factory: NonNullable<CreateCodexAdapterDeps["createTransport"]> = (
    deps,
  ) => {
    createDeps = deps
    onNotification = deps.onNotification
    onServerRequest = deps.onServerRequest
    return transport
  }

  return { fake, factory }
}

interface RecordingCtx {
  readonly ctx: AdapterCtx
  readonly emitted: CanonicalEvent[]
  readonly approvalCalls: Array<{ runnerId: RunnerId; target: ApprovalTarget }>
  readonly questionCalls: Array<{ runnerId: RunnerId; prompt: QuestionPrompt }>
  resolveApproval(decision: ApprovalDecision): void
  resolveQuestion(answer: QuestionAnswer): void
}

const makeCtx = (): RecordingCtx => {
  const emitted: CanonicalEvent[] = []
  const approvalCalls: Array<{ runnerId: RunnerId; target: ApprovalTarget }> =
    []
  const questionCalls: Array<{ runnerId: RunnerId; prompt: QuestionPrompt }> =
    []
  let pendingApproval: ((d: ApprovalDecision) => void) | undefined
  let pendingQuestion: ((a: QuestionAnswer) => void) | undefined
  let child = 0
  const ctx: AdapterCtx = {
    rootRunnerId: root,
    emit: (e) => emitted.push(e),
    newRunnerId: () => `rnr_child_${++child}` as RunnerId,
    requestApproval: (runnerId, target) => {
      approvalCalls.push({ runnerId, target })
      return new Promise<ApprovalDecision>((resolve) => {
        pendingApproval = resolve
      })
    },
    requestQuestion: (runnerId, prompt) => {
      questionCalls.push({ runnerId, prompt })
      return new Promise<QuestionAnswer>((resolve) => {
        pendingQuestion = resolve
      })
    },
  }
  return {
    ctx,
    emitted,
    approvalCalls,
    questionCalls,
    resolveApproval: (d) => pendingApproval?.(d),
    resolveQuestion: (a) => pendingQuestion?.(a),
  }
}

const startInput: AgentStartInput = {
  harnessId: "codex" as never,
  cwd: "/repo",
  env: {},
  modelId: "gpt-5" as never,
}

const makeAdapter = (fake: ReturnType<typeof makeFakeTransport>) =>
  createCodexAdapter({
    idGen: createSequentialIdGen(),
    createTransport: fake.factory,
  })

describe("createCodexAdapter.start", () => {
  it("does initialize → initialized → thread/start and emits the root runner-started", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)

    const methods = ft.fake.outgoing.map(([kind, m]) => `${kind}:${m}`)
    expect(methods).toEqual([
      "request:initialize",
      "notify:initialized",
      "request:thread/start",
    ])
    const threadStart = ft.fake.outgoing.find(([, m]) => m === "thread/start")
    expect(threadStart?.[2]).toEqual({ cwd: "/repo", model: "gpt-5" })
    expect(ctx.emitted).toContainEqual({
      type: "runner-started",
      runnerId: root,
      model: "gpt-5",
    })
  })

  it("spawns `app-server` with ONLY the `-c` overrides, dropping the terminal `-m <model>` flag", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(
      {
        ...startInput,
        // The full resolved codex args: `-c` provider overrides PLUS the TUI `-m <model>`.
        args: [
          "-c",
          "model_provider=spectrum",
          "-c",
          "model_providers.spectrum.base_url=http://127.0.0.1:4000/v1",
          "-m",
          "minimax-m3",
        ],
      },
      ctx.ctx,
    )
    // app-server rejects `-m`; the model is sent via thread/start instead.
    expect(ft.fake.createDeps()?.args).toEqual([
      "app-server",
      "-c",
      "model_provider=spectrum",
      "-c",
      "model_providers.spectrum.base_url=http://127.0.0.1:4000/v1",
    ])
  })

  it("spawns just `app-server` when no harness args are provided", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    expect(ft.fake.createDeps()?.args).toEqual(["app-server"])
  })

  it("rejects start when thread/start rejects", async () => {
    const ft = makeFakeTransport()
    ft.fake.setReject("thread/start", "boom")
    const ctx = makeCtx()
    await expect(makeAdapter(ft).start(startInput, ctx.ctx)).rejects.toThrow(
      "boom",
    )
  })

  it("maps + emits a pushed turn/completed notification", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ctx.emitted.length = 0
    ft.fake.pushNotification({
      method: "turn/completed",
      params: {
        threadId: "th_1",
        turn: { id: "tn_1", items: [], status: "completed", error: null },
      },
    })
    expect(ctx.emitted).toEqual([{ type: "turn-finished", runnerId: root }])
  })

  it("routes a command-approval server request through ctx.requestApproval and replies accept on allow", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "th_1",
        turnId: "tn_1",
        itemId: "it_cmd",
        startedAtMs: 1,
        command: "rm x",
      },
    })
    expect(ctx.approvalCalls).toEqual([
      { runnerId: root, target: { kind: "command", detail: "rm x" } },
    ])
    ctx.resolveApproval("allow")
    await Promise.resolve()
    await Promise.resolve()
    expect(ft.fake.replies).toEqual([{ id: 7, result: { decision: "accept" } }])
  })

  it("replies decline on deny and acceptForSession on allow-always for a file-change approval", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushServerRequest({
      id: 9,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "th_1",
        turnId: "tn_1",
        itemId: "it_fc",
        startedAtMs: 1,
      },
    })
    expect(ctx.approvalCalls[0]?.target.kind).toBe("file")
    ctx.resolveApproval("allow-always")
    await Promise.resolve()
    await Promise.resolve()
    expect(ft.fake.replies).toEqual([
      { id: 9, result: { decision: "acceptForSession" } },
    ])
  })

  it("answers an unsupported server request with a JSON-RPC error", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushServerRequest({
      id: 11,
      method: "item/permissions/requestApproval",
      params: {},
    })
    await Promise.resolve()
    expect(ft.fake.replies).toEqual([
      {
        id: 11,
        error: {
          code: -32601,
          message:
            "unsupported server request: item/permissions/requestApproval",
        },
      },
    ])
  })

  it("send issues turn/start when no turn is active, then turn/steer mid-turn", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    handle.send("first")
    expect(ft.fake.outgoing).toEqual([
      [
        "request",
        "turn/start",
        {
          threadId: "th_1",
          input: [{ type: "text", text: "first", text_elements: [] }],
          model: "gpt-5",
          approvalPolicy: "untrusted",
        },
      ],
    ])

    ft.fake.outgoing.length = 0
    ft.fake.pushNotification({
      method: "turn/started",
      params: {
        threadId: "th_1",
        turn: { id: "tn_active", items: [], status: "inProgress" },
      },
    })
    handle.send("more")
    expect(ft.fake.outgoing).toEqual([
      [
        "request",
        "turn/steer",
        {
          threadId: "th_1",
          input: [{ type: "text", text: "more", text_elements: [] }],
          expectedTurnId: "tn_active",
        },
      ],
    ])
  })

  it("interrupt issues turn/interrupt with the active turn id", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushNotification({
      method: "turn/started",
      params: {
        threadId: "th_1",
        turn: { id: "tn_active", items: [], status: "inProgress" },
      },
    })
    ft.fake.outgoing.length = 0
    handle.interrupt()
    expect(ft.fake.outgoing).toEqual([
      ["request", "turn/interrupt", { threadId: "th_1", turnId: "tn_active" }],
    ])
  })

  it("close is idempotent — closes the transport once", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    handle.close()
    handle.close()
    expect(ft.fake.closed()).toBe(true)
  })

  it("initial turn/start carries approvalPolicy: untrusted for the default manual mode", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    handle.send("hello")
    const turnStart = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((turnStart?.[2] as Record<string, unknown>).approvalPolicy).toBe(
      "untrusted",
    )
    expect(
      (turnStart?.[2] as Record<string, unknown>).sandboxPolicy,
    ).toBeUndefined()
  })

  it("after setMode('bypass'), the next turn/start carries never + dangerFullAccess", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    handle.setMode?.("bypass")
    handle.send("go")
    const turnStart = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((turnStart?.[2] as Record<string, unknown>).approvalPolicy).toBe(
      "never",
    )
    expect((turnStart?.[2] as Record<string, unknown>).sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    })
  })

  it("setModel applies the new model on the next turn/start", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    // First turn/start: uses the initial model from input.modelId.
    handle.send("first")
    const firstTurn = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((firstTurn?.[2] as Record<string, unknown>).model).toBe("gpt-5")

    // Change the model.
    handle.setModel?.("mdl_new" as never)
    ft.fake.outgoing.length = 0

    // Next turn/start: carries the new model.
    handle.send("second")
    const secondTurn = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((secondTurn?.[2] as Record<string, unknown>).model).toBe("mdl_new")
  })

  it("routes a requestUserInput server request through ctx.requestQuestion and replies with id-keyed answers", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushServerRequest({
      id: 20,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "th_1",
        turnId: "tn_1",
        itemId: "it_q",
        questions: [
          {
            id: "q1",
            header: "Pick one",
            question: "Which?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      },
    })
    expect(ctx.questionCalls).toHaveLength(1)
    expect(ctx.questionCalls[0]?.prompt.questions[0]?.header).toBe("Pick one")
    ctx.resolveQuestion({ selections: [{ questionIndex: 0, labels: ["A"] }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(ft.fake.replies).toEqual([
      { id: 20, result: { answers: { q1: { answers: ["A"] } } } },
    ])
  })

  it("responds to mcpServer/elicitation/request with a graceful decline", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.pushServerRequest({
      id: 21,
      method: "mcpServer/elicitation/request",
      params: { title: "some form" },
    })
    await Promise.resolve()
    expect(ft.fake.replies).toEqual([
      {
        id: 21,
        result: { action: "decline", content: null, _meta: null },
      },
    ])
  })

  it("turn/start carries the mapped effort when input.thinkingEffort is set", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(
      { ...startInput, thinkingEffort: "high" },
      ctx.ctx,
    )
    ft.fake.outgoing.length = 0

    handle.send("hello")
    const turnStart = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((turnStart?.[2] as Record<string, unknown>).effort).toBe("high")
  })

  it("turn/start omits effort when no thinkingEffort is set", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    handle.send("hello")
    const turnStart = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((turnStart?.[2] as Record<string, unknown>).effort).toBeUndefined()
  })

  it("setThinkingEffort applies the mapped effort on the next turn/start", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/start", { thread: { id: "th_1" } })
    const ctx = makeCtx()
    const handle = await makeAdapter(ft).start(startInput, ctx.ctx)
    ft.fake.outgoing.length = 0

    // Initially no effort.
    handle.send("first")
    const firstTurn = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((firstTurn?.[2] as Record<string, unknown>).effort).toBeUndefined()

    // Set a new effort.
    handle.setThinkingEffort?.("max")
    ft.fake.outgoing.length = 0

    // Next turn/start carries the mapped effort ("xhigh").
    handle.send("second")
    const secondTurn = ft.fake.outgoing.find(([, m]) => m === "turn/start")
    expect((secondTurn?.[2] as Record<string, unknown>).effort).toBe("xhigh")
  })

  it("calls thread/resume instead of thread/start when input.resume is set, and reports the threadId", async () => {
    const ft = makeFakeTransport()
    ft.fake.setResult("thread/resume", { thread: { id: "thread-9" } })
    const ctx = makeCtx()
    const reported: string[] = []
    const resumeCtx: AdapterCtx = {
      ...ctx.ctx,
      reportResumeToken: (token: string) => reported.push(token),
    }
    await makeAdapter(ft).start(
      {
        harnessId: "codex" as never,
        cwd: "/repo",
        env: {},
        modelId: "gpt-5" as never,
        resume: "thread-9",
        sessionId: "s_1" as never,
      },
      resumeCtx,
    )
    const methods = ft.fake.outgoing.map(([, m]) => m)
    expect(methods).not.toContain("thread/start")
    const resumeCall = ft.fake.outgoing.find(([, m]) => m === "thread/resume")
    expect(resumeCall).toBeDefined()
    expect(resumeCall?.[2]).toEqual({
      threadId: "thread-9",
      cwd: "/repo",
      model: "gpt-5",
    })
    expect(reported).toEqual(["thread-9"])
  })
})
