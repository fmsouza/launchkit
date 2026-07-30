import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalTarget,
  AttachmentRefWithBytes,
  CanonicalEvent,
  PermissionMode,
} from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import type {
  AcpConnect,
  AcpConnection,
  AcpMapState,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdateNotification,
} from "./acp-client"
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
      const supportedModes = supportedModesFrom(session.availableModeIds)
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
          .then(() => {
            ctx.emit({ type: "turn-finished", runnerId: ctx.rootRunnerId })
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
          // Agent-defined mode ids: no-op when this agent cannot honor the mode. The UI only
          // offers modes from `supportedModes`, so this guard is defense in depth.
          const modeId = pickAcpModeId(mode, session.availableModeIds)
          if (modeId !== undefined)
            client.sessionSetMode(session.sessionId, modeId)
        },
      }

      return handle
    },
  }

  return adapter
}
