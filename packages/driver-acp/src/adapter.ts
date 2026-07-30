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
      const session =
        input.resume !== undefined
          ? await client.sessionLoad(input.resume, input.cwd)
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

      /** Apply a Spectrum permission mode through whichever surface this agent advertised. */
      const applyMode = (mode: PermissionMode): void => {
        const modeId = pickAcpModeId(mode, modeIds)
        if (modeId === undefined) return
        if (useSetMode) {
          client.sessionSetMode(session.sessionId, modeId)
          return
        }
        if (modeOption !== undefined)
          client.sessionSetConfigOption(
            session.sessionId,
            modeOption.id,
            modeId,
          )
      }

      // Apply the run's permission mode UP FRONT rather than inheriting the agent's default.
      // claude-agent-acp opens a session in `bypassPermissions` — every tool call auto-approved
      // and the permission callback never consulted — so inheriting would silently disable
      // Spectrum's approval cards. Absent an explicit mode, "manual" is Spectrum's default (and
      // what the retired bespoke drivers used).
      applyMode(input.permissionMode ?? "manual")

      const mapState: AcpMapState = {
        rootRunnerId: ctx.rootRunnerId,
        newRunnerId: ctx.newRunnerId,
        startedToolCalls: new Set<string>(),
      }

      client.onSessionUpdate((notif: AcpSessionUpdateNotification) => {
        for (const event of mapAcpUpdate(notif, mapState)) ctx.emit(event)
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
        client
          .sessionPrompt(session.sessionId, blocks)
          .then((stopReason) => {
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
          client.sessionCancel(session.sessionId)
        },

        close(): void {
          try {
            client.sessionClose(session.sessionId)
          } catch {
            /* idempotent */
          }
          connection.close()
        },

        setMode(mode: PermissionMode): void {
          // Agent-defined mode ids: a no-op when this agent cannot honor the mode. The UI only
          // offers modes from `supportedModes`, so this guard is defense in depth.
          applyMode(mode)
        },

        setModel(modelId: ModelId | null): void {
          // ACP v1 has no live model switch of its own; agents expose it as a session config
          // option. No-op when this agent does not (documented regression, not a silent failure:
          // the UI keeps the user's pick and the next fresh session honors it via env).
          if (modelId === null) return
          const choice = pickModelOption(session.configOptions, String(modelId))
          if (choice !== undefined)
            client.sessionSetConfigOption(
              session.sessionId,
              choice.configId,
              choice.valueId,
            )
        },

        setThinkingEffort(effort: ThinkingEffort): void {
          const choice = pickEffortOption(session.configOptions, effort)
          if (choice !== undefined)
            client.sessionSetConfigOption(
              session.sessionId,
              choice.configId,
              choice.valueId,
            )
        },
      }

      return handle
    },
  }

  return adapter
}
