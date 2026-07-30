import { describe, expect, it } from "bun:test"
import type { CanonicalEvent } from "@spectrum/agent-events"
import type { AdapterCtx } from "@spectrum/driver-runtime"
import type { RunnerId } from "@spectrum/types"
import type {
  AcpClient,
  AcpConnect,
  AcpElicitation,
  AcpPermissionRequest,
  AcpSessionUpdateNotification,
  AcpStopReason,
} from "./acp-client"
import { createAcpAdapter } from "./adapter"

const rid = (s: string): RunnerId => s as RunnerId

/** A recording fake ACP client for unit-testing the adapter without a real agent spawn. */
interface FakeAcpClient extends AcpClient {
  readonly _updateCb: {
    value: ((notif: AcpSessionUpdateNotification) => void) | undefined
  }
  readonly _permissionCb: {
    value: ((req: AcpPermissionRequest) => void) | undefined
  }
  readonly _elicitationCb: {
    value:
      | ((req: {
          sessionId: string
          requestId: string | number
          elicitation: AcpElicitation
        }) => void)
      | undefined
  }
  readonly prompts: { sessionId: string; prompt: unknown[] }[]
  readonly cancels: string[]
  readonly modes: { sessionId: string; mode: string }[]
  readonly closes: string[]
  readonly inits: number
  readonly sessionNews: number
  readonly sessionLoads: readonly string[]
  sessionCloseCalls: string[]
}

const createFakeClient = (): FakeAcpClient => {
  const prompts: { sessionId: string; prompt: unknown[] }[] = []
  const cancels: string[] = []
  const modes: { sessionId: string; mode: string }[] = []
  const closes: string[] = []
  const updateHolder: {
    value: ((notif: AcpSessionUpdateNotification) => void) | undefined
  } = { value: undefined }
  const permissionHolder: {
    value: ((req: AcpPermissionRequest) => void) | undefined
  } = { value: undefined }
  const elicitationHolder: {
    value:
      | ((req: {
          sessionId: string
          requestId: string | number
          elicitation: AcpElicitation
        }) => void)
      | undefined
  } = { value: undefined }
  let inits = 0
  let sessionNews = 0
  const sessionLoads: string[] = []
  const sessionCloseCalls: string[] = []
  const client: FakeAcpClient = {
    _updateCb: updateHolder,
    _permissionCb: permissionHolder,
    _elicitationCb: elicitationHolder,
    prompts,
    cancels,
    modes,
    closes,
    get inits() {
      return inits
    },
    get sessionNews() {
      return sessionNews
    },
    get sessionLoads() {
      return sessionLoads
    },
    sessionCloseCalls,
    initialize: async () => {
      inits++
    },
    sessionNew: async () => {
      sessionNews++
      return "acp-sess-1"
    },
    sessionLoad: async (id) => {
      sessionLoads.push(id)
      return "acp-sess-1"
    },
    sessionPrompt: async (
      sid: string,
      prompt: readonly { type: "text"; text: string }[],
    ): Promise<AcpStopReason> => {
      prompts.push({ sessionId: sid, prompt: [...prompt] })
      return "end_turn"
    },
    sessionCancel: (sid: string) => {
      cancels.push(sid)
    },
    sessionSetMode: (sid: string, mode: string) => {
      modes.push({ sessionId: sid, mode })
    },
    sessionClose: (sid: string) => {
      closes.push(sid)
      sessionCloseCalls.push(sid)
    },
    onSessionUpdate: (cb) => {
      updateHolder.value = cb
      return () => {
        updateHolder.value = undefined
      }
    },
    onPermissionRequest: (cb) => {
      permissionHolder.value = cb
      return () => {
        permissionHolder.value = undefined
      }
    },
    onElicitationCreate: (cb) => {
      elicitationHolder.value = cb
      return () => {
        elicitationHolder.value = undefined
      }
    },
    close: () => {},
  }
  return client
}

const createFakeCtx = (): { ctx: AdapterCtx; events: CanonicalEvent[] } => {
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
      return "allow"
    },
    requestQuestion: async (runnerId, prompt) => {
      const requestId = `qst_${qstCounter++}`
      events.push({ type: "question-requested", runnerId, requestId, prompt })
      return { selections: [] }
    },
    newRunnerId: () => rid(`rnr_child_${runnerCounter++}`),
    rootRunnerId: rid("rnr_root"),
  }
  return { ctx, events }
}

const createFakeConnect = (client: FakeAcpClient): AcpConnect => {
  return async () => ({ client, close: () => {} })
}

describe("createAcpAdapter — start", () => {
  it("returns a DriverAdapter with no supportedModes by default", () => {
    const adapter = createAcpAdapter({
      connect: createFakeConnect(createFakeClient()) as never,
    })
    expect(adapter.supportedModes).toBeUndefined()
  })

  it("initializes the ACP client and creates a new session on start", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    expect(client.inits).toBe(1)
    expect(client.sessionNews).toBe(1)
  })

  it("loads an existing session when resume is provided", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
        resume: "acp-sess-prev",
      },
      ctx,
    )
    expect(client.sessionLoads).toEqual(["acp-sess-prev"])
  })

  it("emits a runner-started for the root runner on start", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx, events } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    const started = events.find((e) => e.type === "runner-started")
    expect(started).toBeDefined()
  })

  it("reports the resume token via ctx when setResumeId is wired", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    let reportedToken: string | undefined
    const { ctx } = createFakeCtx()
    ctx.reportResumeToken = (token) => {
      reportedToken = token
    }
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
        sessionId: "s1" as never,
      },
      ctx,
    )
    expect(reportedToken).toBe("acp-sess-1")
  })

  it("sends the initial prompt when provided", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
        initialPrompt: "hello",
      },
      ctx,
    )
    expect(client.prompts.length).toBeGreaterThanOrEqual(1)
  })
})

describe("createAcpAdapter — handle", () => {
  it("send fires sessionPrompt with text content", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    handle.send({ text: "do something" })
    expect(client.prompts.length).toBeGreaterThanOrEqual(1)
    expect(client.prompts[client.prompts.length - 1]?.prompt).toEqual([
      { type: "text", text: "do something" },
    ])
  })

  it("interrupt fires sessionCancel", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    handle.interrupt()
    expect(client.cancels).toEqual(["acp-sess-1"])
  })

  it("setMode fires sessionSetMode when supported", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
      supportedModes: ["manual", "auto-edits", "bypass"],
    })
    const { ctx } = createFakeCtx()
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    handle.setMode?.("bypass")
    expect(client.modes).toEqual([{ sessionId: "acp-sess-1", mode: "bypass" }])
  })

  it("close closes the client connection", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx } = createFakeCtx()
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    handle.close()
    expect(client.sessionCloseCalls).toContain("acp-sess-1")
  })

  it("emits turn-finished when the prompt response arrives", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx, events } = createFakeCtx()
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    handle.send({ text: "hi" })
    // The prompt promise resolves synchronously in the fake; allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 0))
    const turnFinished = events.find((e) => e.type === "turn-finished")
    expect(turnFinished).toBeDefined()
  })
})

describe("createAcpAdapter — session/update streaming", () => {
  it("maps an agent_message_chunk to a text-delta event via ctx.emit", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx, events } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    client._updateCb.value?.({
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hi" },
      },
    } as AcpSessionUpdateNotification)
    const delta = events.find((e) => e.type === "text-delta")
    expect(delta).toBeDefined()
    expect(delta).toMatchObject({ messageId: "m1", text: "hi" })
  })

  it("emits approval-requested when the agent sends a permission request", async () => {
    const client = createFakeClient()
    const adapter = createAcpAdapter({
      connect: createFakeConnect(client) as never,
    })
    const { ctx, events } = createFakeCtx()
    await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
        command: "claude",
        args: ["--acp"],
      },
      ctx,
    )
    client._permissionCb.value?.({
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "call_1" },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    })
    const approval = events.find((e) => e.type === "approval-requested")
    expect(approval).toBeDefined()
  })
})
