import { describe, expect, it } from "bun:test"
import type { AcpChildProcess } from "./real-connect"
import { createAcpClient, createRealAcpConnect } from "./real-connect"

/**
 * An in-process ACP AGENT built with the SDK itself. `clientApp.connect(agentApp)` is the SDK's
 * documented no-transport path, so these tests exercise the real client wiring (requests,
 * notifications, server→client requests) without spawning anything.
 */
const makeLoopbackAgent = async (
  options: {
    readonly stopReason?: "end_turn" | "refusal" | "cancelled"
    readonly askPermission?: boolean
    readonly askElicitation?: boolean
    readonly sendUnknownUpdate?: boolean
  } = {},
) => {
  const acp = await import("@agentclientprotocol/sdk")
  const agentApp = acp
    .agent()
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    }))
    .onRequest("session/new", () => ({
      sessionId: "sess_1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet" }],
        },
      ],
    }))
    .onRequest("session/load", () => ({
      sessionId: "sess_loaded",
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
    }))
    .onRequest("session/prompt", async (context) => {
      await context.client.notify("session/update", {
        sessionId: "sess_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pong" },
        },
      })
      if (options.sendUnknownUpdate === true) {
        await context.client.notify("session/update", {
          sessionId: "sess_1",
          update: { sessionUpdate: "some_future_kind", payload: 1 },
        })
      }
      if (options.askPermission === true) {
        const outcome = await context.client.request(
          "session/request_permission",
          {
            sessionId: "sess_1",
            toolCall: {
              toolCallId: "call_1",
              title: "rm -rf",
              kind: "execute",
            },
            options: [
              { optionId: "once", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          },
        )
        permissionOutcomes.push(outcome)
      }
      if (options.askElicitation === true) {
        const response = await context.client.request("elicitation/create", {
          mode: "form",
          sessionId: "sess_1",
          message: "Which branch?",
          requestedSchema: {
            type: "object",
            properties: { branch: { type: "string" } },
          },
        })
        elicitationResponses.push(response)
      }
      return { stopReason: options.stopReason ?? "end_turn" }
    })
  return { acp, agentApp }
}

const permissionOutcomes: unknown[] = []
const elicitationResponses: unknown[] = []

describe("createAcpClient", () => {
  it("completes the initialize handshake and reports prompt capabilities", async () => {
    const { agentApp } = await makeLoopbackAgent()
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })

    const init = await client.initialize()

    expect(init.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    })
    client.close()
  })

  it("creates a session and reports the agent's advertised mode ids", async () => {
    const { agentApp } = await makeLoopbackAgent()
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()

    const session = await client.sessionNew("/tmp")

    expect(session.sessionId).toBe("sess_1")
    expect(session.availableModeIds).toEqual(["default", "plan"])
    expect(session.currentModeId).toBe("default")
    client.close()
  })

  it("reports the agent's advertised config options", async () => {
    const { agentApp } = await makeLoopbackAgent()
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()

    const session = await client.sessionNew("/tmp")

    expect(session.configOptions).toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        values: [{ id: "sonnet", name: "Sonnet" }],
      },
    ])
    client.close()
  })

  it("loads an existing session via session/load", async () => {
    const { agentApp } = await makeLoopbackAgent()
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()

    const session = await client.sessionLoad("sess_prev", "/tmp")

    expect(session.sessionId).toBe("sess_prev")
    client.close()
  })

  it("delivers session/update notifications to the registered subscriber", async () => {
    const { agentApp } = await makeLoopbackAgent()
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()
    const session = await client.sessionNew("/tmp")
    const seen: string[] = []
    client.onSessionUpdate((n) => {
      if (n.update.sessionUpdate === "agent_message_chunk")
        seen.push(n.update.content?.text ?? "")
    })

    const stop = await client.sessionPrompt(session.sessionId, [
      { type: "text", text: "ping" },
    ])

    expect(stop).toBe("end_turn")
    expect(seen).toEqual(["pong"])
    client.close()
  })

  it("drops an unrecognized session/update instead of passing it to the subscriber", async () => {
    // The transport zod-validates every inbound notification: an update kind Spectrum does not
    // model must not reach the mapper, and must not kill the run either.
    const { agentApp } = await makeLoopbackAgent({ sendUnknownUpdate: true })
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()
    const session = await client.sessionNew("/tmp")
    const seen: string[] = []
    client.onSessionUpdate((n) => {
      seen.push(n.update.sessionUpdate)
    })

    const stop = await client.sessionPrompt(session.sessionId, [
      { type: "text", text: "ping" },
    ])

    expect(stop).toBe("end_turn")
    expect(seen).toEqual(["agent_message_chunk"])
    client.close()
  })

  it("answers a session/request_permission with the handler's outcome", async () => {
    permissionOutcomes.length = 0
    const { agentApp } = await makeLoopbackAgent({ askPermission: true })
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()
    const session = await client.sessionNew("/tmp")
    client.onPermissionRequest(async (req) => {
      expect(req.options).toHaveLength(2)
      return { outcome: "selected", optionId: "once" }
    })

    await client.sessionPrompt(session.sessionId, [
      { type: "text", text: "ping" },
    ])

    expect(permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "once" } },
    ])
    client.close()
  })

  it("answers an elicitation/create with the handler's response", async () => {
    elicitationResponses.length = 0
    const { agentApp } = await makeLoopbackAgent({ askElicitation: true })
    const client = await createAcpClient({
      connect: (app) => app.connect(agentApp),
    })
    await client.initialize()
    const session = await client.sessionNew("/tmp")
    client.onElicitationCreate(async (req) => {
      expect(req.message).toBe("Which branch?")
      return { action: "accept", content: { branch: "main" } }
    })

    await client.sessionPrompt(session.sessionId, [
      { type: "text", text: "ping" },
    ])

    expect(elicitationResponses).toEqual([
      { action: "accept", content: { branch: "main" } },
    ])
    client.close()
  })
})

const makeFakeProcess = (): AcpChildProcess => ({
  stdout: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  }),
  stdin: { write: () => {}, flush: () => {}, end: () => {} },
  kill: () => {},
})

describe("createRealAcpConnect", () => {
  it("spawns the configured command with its args and the merged env", async () => {
    const calls: { cmd: readonly string[]; env: Record<string, string> }[] = []
    const connect = createRealAcpConnect({
      baseEnv: () => ({ PATH: "/usr/bin", HOME: "/home/me" }),
      spawn: (cmd, opts) => {
        calls.push({ cmd, env: opts.env })
        return makeFakeProcess()
      },
    })

    await connect({
      command: "/usr/local/bin/opencode",
      args: ["acp"],
      cwd: "/work",
      env: { OPENAI_API_KEY: "k" },
    })

    expect(calls[0]?.cmd).toEqual(["/usr/local/bin/opencode", "acp"])
    expect(calls[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/me",
      OPENAI_API_KEY: "k",
    })
  })

  it("lets the per-run env win over the inherited parent env", async () => {
    const envs: Record<string, string>[] = []
    const connect = createRealAcpConnect({
      baseEnv: () => ({ PATH: "/usr/bin", OPENAI_API_KEY: "stale" }),
      spawn: (_cmd, opts) => {
        envs.push(opts.env)
        return makeFakeProcess()
      },
    })

    await connect({
      command: "/bin/agent",
      args: [],
      cwd: "/work",
      env: { OPENAI_API_KEY: "fresh" },
    })

    expect(envs[0]?.OPENAI_API_KEY).toBe("fresh")
  })

  it("spawns in the run's working directory", async () => {
    const cwds: string[] = []
    const connect = createRealAcpConnect({
      baseEnv: () => ({}),
      spawn: (_cmd, opts) => {
        cwds.push(opts.cwd)
        return makeFakeProcess()
      },
    })

    await connect({ command: "/bin/agent", args: [], cwd: "/work", env: {} })

    expect(cwds).toEqual(["/work"])
  })

  it("kills the child process when the connection is closed", async () => {
    let killed = false
    const connect = createRealAcpConnect({
      baseEnv: () => ({}),
      spawn: () => ({
        ...makeFakeProcess(),
        kill: () => {
          killed = true
        },
      }),
    })

    const connection = await connect({
      command: "/bin/agent",
      args: [],
      cwd: "/work",
      env: {},
    })
    connection.close()

    expect(killed).toBe(true)
  })

  it("closes the child's stdin before killing it", async () => {
    // An ACP agent exits cleanly on EOF; killing it with the pipe still open makes it die
    // mid-write and spray EPIPE onto the app's stderr.
    const order: string[] = []
    const connect = createRealAcpConnect({
      baseEnv: () => ({}),
      spawn: () => ({
        ...makeFakeProcess(),
        stdin: {
          write: () => {},
          flush: () => {},
          end: () => {
            order.push("stdin.end")
          },
        },
        kill: () => {
          order.push("kill")
        },
      }),
    })

    const connection = await connect({
      command: "/bin/agent",
      args: [],
      cwd: "/work",
      env: {},
    })
    connection.close()

    expect(order).toEqual(["stdin.end", "kill"])
  })

  it("still kills the child when closing stdin throws", async () => {
    let killed = false
    const connect = createRealAcpConnect({
      baseEnv: () => ({}),
      spawn: () => ({
        ...makeFakeProcess(),
        stdin: {
          write: () => {},
          flush: () => {},
          end: () => {
            throw new Error("already closed")
          },
        },
        kill: () => {
          killed = true
        },
      }),
    })

    const connection = await connect({
      command: "/bin/agent",
      args: [],
      cwd: "/work",
      env: {},
    })
    connection.close()

    expect(killed).toBe(true)
  })
})
