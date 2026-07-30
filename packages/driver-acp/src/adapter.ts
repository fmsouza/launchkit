import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalTarget,
  AttachmentRefWithBytes,
  CanonicalEvent,
  PermissionMode,
  RunnerId,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import type { ModelId } from "@spectrum/types"
import type {
  AcpConnect,
  AcpConnection,
  AcpMapState,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdateNotification,
  AcpStopReason,
} from "./acp-client"
import {
  pickEffortOption,
  pickModeOption,
  pickModelOption,
} from "./config-options"
import {
  answerToElicitationResponse,
  elicitationToQuestion,
  firstPropertyName,
} from "./elicitation"
import { mapAcpUpdate } from "./map-acp-update"
import { pickPermissionOptionId } from "./permission-outcome"
import { toAcpPromptBlocks } from "./prompt-blocks"
import { pickAcpModeId, supportedModesFrom } from "./session-modes"

export interface AcpAdapterDeps {
  readonly connect: AcpConnect
}

/** Canonical events that count as the agent having produced something during a turn. */
const PRODUCTIVE_EVENTS: ReadonlySet<CanonicalEvent["type"]> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-call-started",
  "tool-output-delta",
  "tool-call-finished",
  "plan-update",
  "file-change",
])

/**
 * ACP stop reasons that end a turn ABNORMALLY, with the message the UI shows. `end_turn` and
 * `cancelled` are normal endings (the user asked for the cancel), so they carry no error.
 */
const STOP_ERRORS: Partial<Record<AcpStopReason, string>> = {
  refusal: "the agent refused to continue",
  max_tokens: "the turn stopped at the model's token limit",
  max_turn_requests: "the turn stopped at the agent's request limit",
}

const turnFinishedFor = (
  runnerId: RunnerId,
  stopReason: AcpStopReason,
): CanonicalEvent => {
  const detail = STOP_ERRORS[stopReason]
  return detail === undefined
    ? { type: "turn-finished", runnerId }
    : { type: "turn-finished", runnerId, error: { detail } }
}

/**
 * The approval card's target, read from the tool call the agent wants permission for. ACP tags a
 * tool call with a `kind`; command/file are the two Spectrum renders distinctly.
 */
const permissionTargetFor = (req: AcpPermissionRequest): ApprovalTarget => {
  const tc = req.toolCall as Record<string, unknown>
  const kind = typeof tc.kind === "string" ? tc.kind : undefined
  const detail = typeof tc.title === "string" ? tc.title : (kind ?? "tool call")
  if (kind === "execute") return { kind: "command", detail }
  if (kind === "edit" || kind === "delete" || kind === "move")
    return { kind: "file", detail }
  return { kind: "tool", detail }
}

export const createAcpAdapter = (deps: AcpAdapterDeps): DriverAdapter => {
  const adapter: DriverAdapter = {
    async start(
      input: AgentStartInput,
      ctx: AdapterCtx,
    ): Promise<AdapterHandle> {
      const connection: AcpConnection = await deps.connect({
        command: input.command ?? "",
        args: input.args ?? [],
        cwd: input.cwd,
        env: input.env,
      })
      const client = connection.client

      const init = await client.initialize()
      // Resume, falling back to a fresh session when the agent cannot reload the old one.
      // Spectrum captures the resume token at session CREATION, so a session the user never
      // prompted has no transcript on the agent's side — Codex answers "no rollout found for
      // thread id". Failing the whole run over that would strand the user on a session that is
      // otherwise perfectly usable, so a fresh session is started instead and its id reported.
      const session =
        input.resume !== undefined
          ? await client
              .sessionLoad(input.resume, input.cwd)
              .catch(() => client.sessionNew(input.cwd))
          : await client.sessionNew(input.cwd)

      ctx.reportResumeToken?.(session.sessionId)

      const capabilities = init.promptCapabilities
      // An agent may advertise its modes EITHER via `session/new`'s modes field or as a
      // `category: "mode"` config option (opencode does the latter, leaving `modes` empty). Read
      // both, and remember which one to drive so `setMode` uses the matching method.
      const modeOption = pickModeOption(session.configOptions)
      const modeIds =
        session.availableModeIds.length > 0
          ? session.availableModeIds
          : (modeOption?.values.map((v) => v.id) ?? [])
      const useSetMode = session.availableModeIds.length > 0
      const supportedModes = supportedModesFrom(modeIds)
      // Re-emit the root runner-started, now carrying what THIS agent negotiated. The runtime
      // emitted a capability-less one before `start`; the reducer merges field-by-field
      // (`event.x ?? existing?.x`), so this re-emit is how per-agent capabilities reach the UI
      // without needing a driver instance per harness.
      const rootStarted: CanonicalEvent = {
        type: "runner-started",
        runnerId: ctx.rootRunnerId,
        ...(supportedModes.length > 0
          ? { supportedModes: [...supportedModes] }
          : {}),
        supportedAttachments: {
          image: capabilities.image,
          // ACP carries non-image attachments as embedded resources; one capability gates both.
          pdf: capabilities.embeddedContext,
          binary: capabilities.embeddedContext,
        },
      }
      ctx.emit(rootStarted)

      /**
       * Apply a Spectrum permission mode through whichever surface this agent advertised.
       * Resolves once the agent has ACCEPTED it — or declined it, because a mode the agent will
       * not take must never strand the turn.
       */
      const applyMode = async (mode: PermissionMode): Promise<void> => {
        const modeId = pickAcpModeId(mode, modeIds)
        if (modeId === undefined) return
        try {
          if (useSetMode) {
            await client.sessionSetMode(session.sessionId, modeId)
            return
          }
          if (modeOption !== undefined)
            await client.sessionSetConfigOption(
              session.sessionId,
              modeOption.id,
              modeId,
            )
        } catch {
          /* the agent declined the mode; the turn still goes ahead */
        }
      }

      // Apply the run's permission mode UP FRONT rather than inheriting the agent's default, and
      // AWAIT it before the first prompt. `claude-agent-acp` opens a session in
      // `bypassPermissions` — every tool call auto-approved and the permission callback never
      // consulted — and set_mode is a REQUEST, so firing it without awaiting let the prompt
      // overtake it and the whole first turn ran wide open (observed live). Absent an explicit
      // mode, "manual" is Spectrum's default, as it was for the retired bespoke drivers.
      await applyMode(input.permissionMode ?? "manual")

      const mapState: AcpMapState = {
        rootRunnerId: ctx.rootRunnerId,
        newRunnerId: ctx.newRunnerId,
        startedToolCalls: new Set<string>(),
      }

      // Count what the agent actually PRODUCED, so a turn that yields nothing can be reported as
      // such rather than as a clean finish (see `runPrompt`).
      let output = 0
      client.onSessionUpdate((notif: AcpSessionUpdateNotification) => {
        for (const event of mapAcpUpdate(notif, mapState)) {
          if (PRODUCTIVE_EVENTS.has(event.type)) output += 1
          ctx.emit(event)
        }
      })

      // session/request_permission is a REQUEST — the agent blocks until we answer. Resolve with
      // the option id matching the user's decision, or cancel when the agent offered none that fits
      // (answering with a wrong-polarity option would be worse than declining to choose).
      client.onPermissionRequest(async (req): Promise<AcpPermissionOutcome> => {
        const decision = await ctx.requestApproval(
          ctx.rootRunnerId,
          permissionTargetFor(req),
        )
        const optionId = pickPermissionOptionId(decision, req.options)
        return optionId === undefined
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId }
      })

      client.onElicitationCreate(async (elicitation) => {
        const answer = await ctx.requestQuestion(
          ctx.rootRunnerId,
          elicitationToQuestion(elicitation),
        )
        return answerToElicitationResponse(
          answer,
          firstPropertyName(elicitation),
        )
      })

      /** Fire one prompt turn. Fire-and-forget per the `AdapterHandle.send(): void` contract. */
      const runPrompt = (
        text: string,
        attachments?: readonly AttachmentRefWithBytes[],
      ): void => {
        const blocks = toAcpPromptBlocks({
          text,
          ...(attachments !== undefined ? { attachments } : {}),
          capabilities,
        })
        if (blocks.length === 0) return
        const outputAtStart = output
        client
          .sessionPrompt(session.sessionId, blocks)
          .then((stopReason) => {
            // An agent can answer `end_turn` having produced nothing — observed live when an
            // OpenClaw gateway had no provider auth: the user saw a successful-looking empty turn
            // and no explanation. Say so instead of reporting success.
            if (stopReason === "end_turn" && output === outputAtStart) {
              ctx.emit({
                type: "turn-finished",
                runnerId: ctx.rootRunnerId,
                error: {
                  detail:
                    "the agent finished the turn without producing any output",
                },
              })
              return
            }
            ctx.emit(turnFinishedFor(ctx.rootRunnerId, stopReason))
          })
          .catch((error: unknown) => {
            ctx.emit({
              type: "turn-finished",
              runnerId: ctx.rootRunnerId,
              error: { detail: String(error) },
            })
          })
      }

      if (input.initialPrompt !== undefined && input.initialPrompt !== "")
        runPrompt(input.initialPrompt)

      const handle: AdapterHandle = {
        send(turn: {
          readonly text: string
          readonly attachments?: readonly AttachmentRefWithBytes[]
        }): void {
          runPrompt(turn.text, turn.attachments)
        },

        interrupt(): void {
          void client.sessionCancel(session.sessionId).catch(() => {})
        },

        close(): void {
          void client.sessionClose(session.sessionId).catch(() => {})
          connection.close()
        },

        setMode(mode: PermissionMode): void {
          // Agent-defined mode ids: a no-op when this agent cannot honor the mode. The UI only
          // offers modes from `supportedModes`, so this guard is defense in depth.
          void applyMode(mode)
        },

        setModel(modelId: ModelId | null): void {
          // ACP v1 has no live model switch of its own; agents expose it as a session config
          // option. No-op when this agent does not (documented regression, not a silent failure:
          // the UI keeps the user's pick and the next fresh session honors it via env).
          if (modelId === null) return
          const choice = pickModelOption(session.configOptions, String(modelId))
          if (choice !== undefined)
            void client
              .sessionSetConfigOption(
                session.sessionId,
                choice.configId,
                choice.valueId,
              )
              .catch(() => {})
        },

        setThinkingEffort(effort: ThinkingEffort): void {
          const choice = pickEffortOption(session.configOptions, effort)
          if (choice !== undefined)
            void client
              .sessionSetConfigOption(
                session.sessionId,
                choice.configId,
                choice.valueId,
              )
              .catch(() => {})
        },
      }

      return handle
    },
  }

  return adapter
}
