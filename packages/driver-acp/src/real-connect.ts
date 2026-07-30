import type {
  AcpClient,
  AcpConfigOption,
  AcpConnect,
  AcpConnectConfig,
  AcpConnection,
  AcpElicitationResponse,
  AcpInitializeResult,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionInfo,
  AcpSessionUpdateNotification,
  AcpStopReason,
} from "./acp-client"
import {
  AcpElicitationSchema,
  AcpPermissionRequestSchema,
  AcpSessionUpdateNotificationSchema,
  AcpStopReasonSchema,
} from "./acp-client"

/** The SDK's client app + connection, kept structural so this file owns no SDK import at type level. */
interface ClientAppLike {
  onNotification(
    method: string,
    handler: (ctx: { params: unknown }) => void,
  ): ClientAppLike
  onRequest(
    method: string,
    handler: (ctx: { params: unknown }) => Promise<unknown>,
  ): ClientAppLike
  /** Connect to a transport stream (production) or directly to an agent app (tests). */
  connect(target: unknown): ClientConnectionLike
}

interface ClientConnectionLike {
  readonly agent: {
    request(method: string, params?: unknown): Promise<unknown>
    notify(method: string, params?: unknown): Promise<void>
  }
  close(error?: unknown): void
}

/** The child process shape the transport needs — Bun.spawn satisfies it structurally. */
export interface AcpChildProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stdin: {
    write(chunk: Uint8Array): void
    flush(): void
    end(): void
  }
  kill(): void
}

export interface AcpSpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
}

export type AcpSpawn = (
  cmd: readonly string[],
  options: AcpSpawnOptions,
) => AcpChildProcess

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}

/** Read `modes.availableModes[].id` off a session response. Defensive: agents may omit modes. */
const modeIdsOf = (response: Record<string, unknown>): readonly string[] => {
  const modes = asRecord(response.modes)
  const available = modes.availableModes
  if (!Array.isArray(available)) return []
  return available
    .map((m) => asRecord(m).id)
    .filter((id): id is string => typeof id === "string")
}

const currentModeIdOf = (
  response: Record<string, unknown>,
): string | undefined => {
  const id = asRecord(response.modes).currentModeId
  return typeof id === "string" ? id : undefined
}

/**
 * Read a select option's choices. ACP allows either a flat `[{ value, name }]` list or groups
 * (`[{ group, name, options: [...] }]`); groups are flattened so the pickers see one shape.
 */
const selectValuesOf = (
  raw: unknown,
): readonly { id: string; name: string }[] => {
  if (!Array.isArray(raw)) return []
  const out: { id: string; name: string }[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (Array.isArray(record.options)) {
      out.push(...selectValuesOf(record.options))
      continue
    }
    if (typeof record.value === "string" && typeof record.name === "string")
      out.push({ id: record.value, name: record.name })
  }
  return out
}

/** Read `configOptions[]` off a session response, keeping only well-formed select entries. */
const configOptionsOf = (
  response: Record<string, unknown>,
): readonly AcpConfigOption[] => {
  const options = response.configOptions
  if (!Array.isArray(options)) return []
  const out: AcpConfigOption[] = []
  for (const raw of options) {
    const option = asRecord(raw)
    if (typeof option.id !== "string" || typeof option.name !== "string")
      continue
    const category =
      typeof option.category === "string" ? option.category : undefined
    out.push({
      id: option.id,
      name: option.name,
      ...(category !== undefined ? { category } : {}),
      values: selectValuesOf(option.options),
    })
  }
  return out
}

/**
 * Adapt an SDK client app to the `AcpClient` port.
 *
 * The caller supplies `connect` rather than a live connection because the SDK's inbound handlers
 * (`session/update`, `session/request_permission`, `elicitation/create`) are registered on the APP,
 * before it connects — while the port's `onX` methods are called after `start` has a client. The
 * shims registered here therefore read mutable closure variables the `onX` methods swap.
 *
 * Real transport: `connect: (app) => app.connect(ndJsonStream(writable, child.stdout))`.
 * Tests: `connect: (app) => agentApp.connect(app)` — the SDK's in-process loopback.
 *
 * SECURITY: nothing here logs; the connect config carries the per-run proxy key in `env`.
 */
export const createAcpClient = async (deps: {
  readonly connect: (app: ClientAppLike) => ClientConnectionLike
}): Promise<AcpClient> => {
  const acp = await import("@agentclientprotocol/sdk")

  let updateCb: ((notif: AcpSessionUpdateNotification) => void) | undefined
  let permissionCb:
    | ((req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>)
    | undefined
  let elicitationCb:
    | ((
        req: import("./acp-client").AcpElicitation,
      ) => Promise<AcpElicitationResponse>)
    | undefined

  // Every inbound payload is validated at this boundary (it is external input). A malformed
  // notification is DROPPED rather than thrown: one bad update must not kill a live run.
  const app = (acp.client() as unknown as ClientAppLike)
    .onNotification("session/update", (ctx) => {
      const parsed = AcpSessionUpdateNotificationSchema.safeParse(ctx.params)
      if (!parsed.success) return
      updateCb?.(parsed.data)
    })
    .onRequest("session/request_permission", async (ctx) => {
      const parsed = AcpPermissionRequestSchema.safeParse(ctx.params)
      if (!parsed.success || permissionCb === undefined)
        return { outcome: { outcome: "cancelled" } }
      return { outcome: await permissionCb(parsed.data) }
    })
    .onRequest("elicitation/create", async (ctx) => {
      const parsed = AcpElicitationSchema.safeParse(ctx.params)
      if (!parsed.success || elicitationCb === undefined)
        return { action: "decline" }
      return await elicitationCb(parsed.data)
    })

  const connection = deps.connect(app)
  const agent = connection.agent

  /** Fire-and-forget: the port's mutators return void, so a transport rejection is swallowed. */
  const fire = (method: string, params: unknown): void => {
    void agent.request(method, params).catch(() => {})
  }

  const client: AcpClient = {
    initialize: async (): Promise<AcpInitializeResult> => {
      const response = asRecord(
        await agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          // Spectrum lets the agent own fs and terminal access; both capabilities are declined.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
      )
      const caps = asRecord(
        asRecord(response.agentCapabilities).promptCapabilities,
      )
      return {
        promptCapabilities: {
          image: caps.image === true,
          audio: caps.audio === true,
          embeddedContext: caps.embeddedContext === true,
        },
      }
    },

    sessionNew: async (cwd: string): Promise<AcpSessionInfo> => {
      const response = asRecord(
        await agent.request("session/new", { cwd, mcpServers: [] }),
      )
      const sessionId =
        typeof response.sessionId === "string" ? response.sessionId : ""
      const currentModeId = currentModeIdOf(response)
      return {
        sessionId,
        availableModeIds: modeIdsOf(response),
        ...(currentModeId !== undefined ? { currentModeId } : {}),
        configOptions: configOptionsOf(response),
      }
    },

    sessionLoad: async (
      sessionId: string,
      cwd: string,
    ): Promise<AcpSessionInfo> => {
      // ACP's load response carries the session's modes/config but not its id — the id is the one
      // we asked to load, so it is threaded through rather than read back.
      const response = asRecord(
        await agent.request("session/load", { sessionId, cwd, mcpServers: [] }),
      )
      const currentModeId = currentModeIdOf(response)
      return {
        sessionId,
        availableModeIds: modeIdsOf(response),
        ...(currentModeId !== undefined ? { currentModeId } : {}),
        configOptions: configOptionsOf(response),
      }
    },

    sessionPrompt: async (sessionId, prompt): Promise<AcpStopReason> => {
      const response = asRecord(
        await agent.request("session/prompt", {
          sessionId,
          prompt: [...prompt],
        }),
      )
      const parsed = AcpStopReasonSchema.safeParse(response.stopReason)
      // An agent that answers with an unknown stop reason still ended its turn; treat it as a
      // clean end rather than failing the run.
      return parsed.success ? parsed.data : "end_turn"
    },

    sessionCancel: (sessionId) => {
      void agent.notify("session/cancel", { sessionId }).catch(() => {})
    },

    sessionSetMode: (sessionId, modeId) => {
      fire("session/set_mode", { sessionId, modeId })
    },

    sessionSetConfigOption: (sessionId, configId, valueId) => {
      fire("session/set_config_option", { sessionId, configId, value: valueId })
    },

    sessionClose: (sessionId) => {
      fire("session/close", { sessionId })
    },

    onSessionUpdate: (cb) => {
      updateCb = cb
      return () => {
        updateCb = undefined
      }
    },

    onPermissionRequest: (cb) => {
      permissionCb = cb
    },

    onElicitationCreate: (cb) => {
      elicitationCb = cb
    },

    close: () => {
      connection.close()
    },
  }

  return client
}

/** Parent env merged UNDER the per-run env, so the child inherits PATH/HOME but never a stale key. */
const mergedEnv = (
  baseEnv: () => Record<string, string | undefined>,
  runEnv: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv()))
    if (value !== undefined) out[key] = value
  for (const [key, value] of Object.entries(runEnv)) out[key] = value
  return out
}

/**
 * The production transport: spawn the agent in ACP mode and speak newline-delimited JSON-RPC over
 * its stdio. The spawn seam is injected so the wiring is testable without starting a process.
 *
 * SECURITY: `config.env` carries the per-run proxy key — never log it, and never log the merged env.
 */
export const createRealAcpConnect = (deps: {
  readonly baseEnv?: () => Record<string, string | undefined>
  readonly spawn?: AcpSpawn
}): AcpConnect => {
  const baseEnv =
    deps.baseEnv ?? (() => process.env as Record<string, string | undefined>)
  return async (config: AcpConnectConfig): Promise<AcpConnection> => {
    const acp = await import("@agentclientprotocol/sdk")
    const spawn: AcpSpawn =
      deps.spawn ??
      ((cmd, options) =>
        Bun.spawn([...cmd], {
          cwd: options.cwd,
          env: options.env,
          stdin: "pipe",
          stdout: "pipe",
          // The agent's own diagnostics go to the app's stderr, where the log tail picks them up.
          stderr: "inherit",
        }) as unknown as AcpChildProcess)

    const child = spawn([config.command, ...config.args], {
      cwd: config.cwd,
      env: mergedEnv(baseEnv, config.env),
    })

    // Bun's stdin is a FileSink, not a WritableStream — adapt it for the SDK's ndjson stream.
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        child.stdin.write(chunk)
        child.stdin.flush()
      },
      close() {
        child.stdin.end()
      },
    })

    const stream = acp.ndJsonStream(writable, child.stdout)
    const client = await createAcpClient({
      connect: (app) => app.connect(stream),
    })

    return {
      client,
      close: () => {
        // Close stdin FIRST: an ACP agent exits cleanly on EOF, while killing it while the pipe is
        // still open makes it die mid-write (EPIPE noise on the app's stderr). `kill` remains the
        // backstop for an agent that ignores EOF. Each step is independently guarded so a failure
        // in one still runs the rest — `close` must be idempotent and total.
        try {
          child.stdin.end()
        } catch {
          /* already closed */
        }
        try {
          client.close()
        } catch {
          /* already closed */
        }
        try {
          child.kill()
        } catch {
          /* already exited */
        }
      },
    }
  }
}
