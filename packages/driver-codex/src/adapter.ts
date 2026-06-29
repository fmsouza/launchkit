import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  PermissionMode,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import type { IdGen } from "@spectrum/utils"
import type { ToolRequestUserInputParams } from "./bindings/v2/ToolRequestUserInputParams"
import { type CodexMapState, mapCodexEvent } from "./map-codex-event"
import {
  mapAnswerToUserInputResponse,
  mapUserInputParams,
} from "./map-user-input"
import { CODEX_SUPPORTED_MODES, toCodexTurnPolicy } from "./permission-mode"
import {
  M_INITIALIZE,
  M_INITIALIZED,
  M_THREAD_RESUME,
  M_THREAD_START,
  M_TURN_INTERRUPT,
  M_TURN_START,
  M_TURN_STEER,
  REQ_COMMAND_APPROVAL,
  REQ_ELICITATION,
  REQ_FILECHANGE_APPROVAL,
  REQ_USER_INPUT,
  TURN_COMPLETED,
  TURN_STARTED,
  textInput,
} from "./protocol"
import type { CodexServerNotification } from "./protocol"
import { toCodexReasoningEffort } from "./thinking-effort"
import {
  type JsonRpcTransport,
  type NotificationFrame,
  type ServerRequestFrame,
  type SpawnFn,
  createBunSpawn,
  createStdioJsonRpcTransport,
} from "./transport"

/** The deps a transport factory receives (so tests can inject a fake transport). */
export interface CreateTransportDeps {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly idGen: IdGen
  readonly onNotification: (n: NotificationFrame) => void
  readonly onServerRequest: (r: ServerRequestFrame) => void
}

export interface CreateCodexAdapterDeps {
  readonly idGen: IdGen
  /** The injected real spawn (default `createBunSpawn()`); ignored when `createTransport` is supplied. */
  readonly spawn?: SpawnFn
  /** Override the transport factory in tests; production builds the real stdio transport. */
  readonly createTransport?: (deps: CreateTransportDeps) => JsonRpcTransport
  /** The resolved `codex` executable; falls back to `input.command` then `"codex"`. */
  readonly command?: string
  /** Parent env merged UNDER `input.env` so the child inherits PATH/HOME (default `process.env`). */
  readonly baseEnv?: () => Record<string, string | undefined>
}

/** Map a canonical decision to a codex command-execution decision string. */
const toCommandDecision = (decision: ApprovalDecision): string =>
  decision === "deny"
    ? "decline"
    : decision === "allow-always"
      ? "acceptForSession"
      : "accept"

/** Map a canonical decision to a codex file-change decision string. */
const toFileDecision = (decision: ApprovalDecision): string =>
  toCommandDecision(decision)

/** The human-readable command detail for a command-approval request. */
const commandDetail = (params: unknown): string => {
  const p = params as {
    command?: unknown
    commandActions?: unknown
    itemId?: unknown
  }
  if (typeof p.command === "string") return p.command
  if (Array.isArray(p.commandActions)) return p.commandActions.join(" ")
  return typeof p.itemId === "string" ? p.itemId : "command"
}

/** The detail for a file-change approval request. */
const fileDetail = (params: unknown): string => {
  const p = params as { itemId?: unknown }
  return typeof p.itemId === "string" ? p.itemId : "file change"
}

/**
 * Keep only the `-c key=value` config overrides from the harness-resolved args. The terminal `codex`
 * command also carries `-m <model>` (TUI model select), which `codex app-server` REJECTS ("unexpected
 * argument '-m'") — app-server takes the model via `thread/start` instead. The `-c` provider overrides
 * (model_providers.spectrum.*) DO apply to app-server, so forward exactly those. PURE.
 */
const appServerArgs = (args: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c" && i + 1 < args.length) {
      out.push("-c", args[i + 1] as string)
      i += 1
    }
  }
  return out
}

/** Build the parent-env merge for the spawned `codex app-server` (proxy/per-run vars win). */
const mergedEnv = (
  baseEnv: () => Record<string, string | undefined>,
  inputEnv: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv())) {
    if (v !== undefined) out[k] = v
  }
  for (const [k, v] of Object.entries(inputEnv)) out[k] = v
  return out
}

/** Return `{ effort: <value> }` when the effort is defined and maps to a supported tier; `{}` otherwise. */
const effortField = (
  effort: ThinkingEffort | undefined,
  modelId: string | undefined,
):
  | { effort: ReturnType<typeof toCodexReasoningEffort> }
  | Record<never, never> => {
  if (effort === undefined) return {}
  const e = toCodexReasoningEffort(effort, modelId)
  return e !== undefined ? { effort: e } : {}
}

/**
 * Build the Codex `DriverAdapter`. `start` spawns `codex app-server` (behind the injected transport),
 * runs the `initialize`→`initialized`→`thread/start` handshake, pumps notifications through
 * `mapCodexEvent` into `ctx.emit`, bridges approval REQUESTS through `ctx.requestApproval`, and maps
 * `send`/`interrupt`/`close` onto `turn/start`|`turn/steer` / `turn/interrupt` / process-kill.
 */
export const createCodexAdapter = (
  deps: CreateCodexAdapterDeps,
): DriverAdapter => ({
  start: async (
    input: AgentStartInput,
    ctx: AdapterCtx,
  ): Promise<AdapterHandle> => {
    const state: CodexMapState = {
      rootRunnerId: ctx.rootRunnerId,
      messageIds: new Map(),
      callIds: new Map(),
      runnerIds: new Map(),
      newRunnerId: ctx.newRunnerId,
      newCallId: () => deps.idGen.next("call"),
      nextMessageId: () => deps.idGen.next("msg"),
    }

    let activeTurnId: string | undefined
    let mode: PermissionMode = input.permissionMode ?? "manual"
    let model: string | undefined =
      input.modelId !== undefined ? String(input.modelId) : undefined
    let currentEffort: ThinkingEffort | undefined = input.thinkingEffort

    const handleServerRequest = (r: ServerRequestFrame): void => {
      const dispatcher = transport.dispatcher
      if (r.method === REQ_COMMAND_APPROVAL) {
        void ctx
          .requestApproval(ctx.rootRunnerId, {
            kind: "command",
            detail: commandDetail(r.params),
          })
          .then((decision) => {
            dispatcher.respond(r.id, { decision: toCommandDecision(decision) })
          })
        return
      }
      if (r.method === REQ_FILECHANGE_APPROVAL) {
        void ctx
          .requestApproval(ctx.rootRunnerId, {
            kind: "file",
            detail: fileDetail(r.params),
          })
          .then((decision) => {
            dispatcher.respond(r.id, { decision: toFileDecision(decision) })
          })
        return
      }
      if (r.method === REQ_USER_INPUT) {
        const params = r.params as ToolRequestUserInputParams
        void ctx
          .requestQuestion(ctx.rootRunnerId, mapUserInputParams(params))
          .then((answer) => {
            dispatcher.respond(
              r.id,
              mapAnswerToUserInputResponse(params, answer),
            )
          })
        return
      }
      if (r.method === REQ_ELICITATION) {
        // MCP elicitation uses a rich form schema we do not yet render; decline gracefully so the
        // server is not left hanging (better than a -32601 error). Tracked as a follow-up.
        dispatcher.respond(r.id, {
          action: "decline",
          content: null,
          _meta: null,
        })
        return
      }
      dispatcher.respondError(
        r.id,
        -32601,
        `unsupported server request: ${r.method}`,
      )
    }

    const handleNotification = (n: NotificationFrame): void => {
      // Tap the raw turn lifecycle to track the active turn id BEFORE mapping.
      if (n.method === TURN_STARTED) {
        const p = n.params as { turn?: { id?: unknown } }
        if (typeof p.turn?.id === "string") activeTurnId = p.turn.id
      } else if (n.method === TURN_COMPLETED) {
        activeTurnId = undefined
      }
      for (const event of mapCodexEvent(n as CodexServerNotification, state)) {
        ctx.emit(event)
      }
    }

    const command = input.command ?? deps.command ?? "codex"
    const createTransport =
      deps.createTransport ??
      ((tdeps: CreateTransportDeps) =>
        createStdioJsonRpcTransport({
          ...tdeps,
          spawn: deps.spawn ?? createBunSpawn(),
        }))

    const transport = createTransport({
      command,
      // `app-server` then ONLY the `-c` provider overrides (`model_providers.spectrum.*`) so it routes
      // through the Spectrum proxy. The terminal path's `-m <model>` is dropped (app-server rejects it;
      // the model is sent via thread/start below).
      args: ["app-server", ...appServerArgs(input.args ?? [])],
      cwd: input.cwd,
      env: mergedEnv(deps.baseEnv ?? (() => process.env), input.env),
      idGen: deps.idGen,
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
    })
    const dispatcher = transport.dispatcher

    // Handshake: initialize (request) → initialized (notification).
    await dispatcher.request(M_INITIALIZE, {
      clientInfo: { name: "spectrum", title: "Spectrum", version: "0" },
      capabilities: { experimentalApi: true },
    })
    dispatcher.notify(M_INITIALIZED, undefined)

    // thread/start (fresh) or thread/resume (by threadId) depending on input.resume.
    const startOrResume =
      input.resume !== undefined ? M_THREAD_RESUME : M_THREAD_START
    const startResult = (await dispatcher.request(startOrResume, {
      ...(input.resume !== undefined ? { threadId: input.resume } : {}),
      cwd: input.cwd,
      ...(input.modelId !== undefined ? { model: String(input.modelId) } : {}),
    })) as { thread: { id: string } }
    const threadId = startResult.thread.id
    ctx.reportResumeToken?.(threadId)

    // Root runner-started (the runtime already emitted one up front; this re-emit carries the model).
    ctx.emit({
      type: "runner-started",
      runnerId: ctx.rootRunnerId,
      ...(input.modelId !== undefined ? { model: String(input.modelId) } : {}),
    })

    if (input.initialPrompt !== undefined) {
      void dispatcher
        .request(M_TURN_START, {
          threadId,
          input: [textInput(input.initialPrompt)],
          ...(model !== undefined ? { model } : {}),
          ...toCodexTurnPolicy(mode),
          ...effortField(currentEffort, model),
        })
        .catch((err: unknown) => {
          ctx.emit({
            type: "runner-finished",
            runnerId: ctx.rootRunnerId,
            status: "errored",
            error: String(err),
          })
        })
    }

    let closed = false
    return {
      send: (text) => {
        const turn =
          activeTurnId !== undefined
            ? dispatcher.request(M_TURN_STEER, {
                threadId,
                input: [textInput(text)],
                expectedTurnId: activeTurnId,
              })
            : dispatcher.request(M_TURN_START, {
                threadId,
                input: [textInput(text)],
                ...(model !== undefined ? { model } : {}),
                ...toCodexTurnPolicy(mode),
                ...effortField(currentEffort, model),
              })
        void turn.catch((err: unknown) => {
          ctx.emit({
            type: "runner-finished",
            runnerId: ctx.rootRunnerId,
            status: "errored",
            error: String(err),
          })
        })
      },
      setMode: (m) => {
        mode = m // turn/steer takes no policy; applied on the next turn/start
      },
      setModel: (m) => {
        model = String(m) // turn/steer takes no model; applied on the next turn/start
      },
      setThinkingEffort: (effort) => {
        currentEffort = effort // re-asserted on the next turn/start
      },
      interrupt: () => {
        if (activeTurnId !== undefined) {
          void dispatcher
            .request(M_TURN_INTERRUPT, { threadId, turnId: activeTurnId })
            .catch(() => {})
        }
      },
      close: () => {
        if (closed) return
        closed = true
        transport.close()
      },
    }
  },
  supportedModes: CODEX_SUPPORTED_MODES,
})
