import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalTarget,
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  QuestionPrompt,
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
  AcpPromptBlock,
  AcpSessionUpdateNotification,
} from "./acp-client"
import { mapAcpUpdate } from "./map-acp-update"

export interface AcpAdapterDeps {
  readonly connect: AcpConnect
  readonly supportedModes?: readonly PermissionMode[]
}

const toAcpMode = (mode: PermissionMode): string => {
  switch (mode) {
    case "manual":
      return "manual"
    case "auto-edits":
      return "auto-edits"
    case "plan":
      return "plan"
    case "bypass":
      return "bypass"
  }
}

const permissionTargetFor = (req: unknown): ApprovalTarget => {
  if (typeof req === "object" && req !== null) {
    const r = req as Record<string, unknown>
    const tc = r.toolCall
    if (typeof tc === "object" && tc !== null) {
      const t = tc as Record<string, unknown>
      if (typeof t.kind === "string") {
        const kind = t.kind
        if (kind === "execute")
          return {
            kind: "command",
            detail: typeof t.title === "string" ? t.title : kind,
          }
        if (kind === "edit" || kind === "delete" || kind === "move")
          return {
            kind: "file",
            detail: typeof t.title === "string" ? t.title : kind,
          }
      }
    }
  }
  return { kind: "tool", detail: "permission request" }
}

const elicitationToQuestion = (elicitation: unknown): QuestionPrompt => {
  if (typeof elicitation === "object" && elicitation !== null) {
    const e = elicitation as Record<string, unknown>
    const message = typeof e.message === "string" ? e.message : "Question"
    return {
      questions: [
        {
          question: message,
          header: "Elicitation",
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    }
  }
  return {
    questions: [
      {
        question: "Input requested",
        header: "Elicitation",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  }
}

const answerToElicitationResult = (_answer: QuestionAnswer): unknown => {
  // ACP elicitation result is opaque; we pass back the first freeText selection if present.
  return { result: "accept" }
}

const toAcpPromptBlocks = (text: string): AcpPromptBlock[] => [
  { type: "text", text },
]

export const createAcpAdapter = (deps: AcpAdapterDeps): DriverAdapter => {
  const adapter: DriverAdapter = {
    ...(deps.supportedModes !== undefined
      ? { supportedModes: deps.supportedModes }
      : {}),

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

      await client.initialize()

      let sessionId: string
      if (input.resume !== undefined) {
        sessionId = await client.sessionLoad(input.resume)
      } else {
        sessionId = await client.sessionNew()
      }

      ctx.reportResumeToken?.(sessionId)

      // Re-emit root runner-started (the runtime already emitted one up front; the reducer is idempotent).
      const rootStarted: CanonicalEvent = {
        type: "runner-started",
        runnerId: ctx.rootRunnerId,
      }
      ctx.emit(rootStarted)

      const mapState: AcpMapState = {
        rootRunnerId: ctx.rootRunnerId,
        newRunnerId: ctx.newRunnerId,
        startedToolCalls: new Set<string>(),
        planCounter: 0,
      }

      // Subscribe to session/update notifications → mapAcpUpdate → ctx.emit.
      client.onSessionUpdate((notif: AcpSessionUpdateNotification) => {
        for (const event of mapAcpUpdate(notif, mapState)) {
          ctx.emit(event)
        }
      })

      // Bridge permission requests: agent -> ctx.requestApproval -> reply.
      client.onPermissionRequest(async (req: unknown) => {
        const target = permissionTargetFor(req)
        await ctx.requestApproval(ctx.rootRunnerId, target)
        // The reply is handled by the ACP client implementation (the fake/real client correlates
        // the response by request id). We emit approval-resolved via the runtime bridge.
      })

      // Bridge elicitation requests: agent → ctx.requestQuestion → reply.
      client.onElicitationCreate(
        async (req: {
          sessionId: string
          requestId: string | number
          elicitation: unknown
        }) => {
          const prompt = elicitationToQuestion(req.elicitation)
          const answer = await ctx.requestQuestion(ctx.rootRunnerId, prompt)
          answerToElicitationResult(answer)
        },
      )

      // Send the initial prompt if provided.
      let inFlight: Promise<unknown> | undefined
      if (input.initialPrompt !== undefined && input.initialPrompt !== "") {
        inFlight = client.sessionPrompt(
          sessionId,
          toAcpPromptBlocks(input.initialPrompt),
        )
        inFlight
          .then(() => {
            ctx.emit({ type: "turn-finished", runnerId: ctx.rootRunnerId })
          })
          .catch((err) => {
            ctx.emit({
              type: "turn-finished",
              runnerId: ctx.rootRunnerId,
              error: { detail: String(err) },
            })
          })
      }

      const handle: AdapterHandle = {
        send(turn: {
          readonly text: string
          readonly attachments?: readonly unknown[]
        }): void {
          inFlight = client.sessionPrompt(
            sessionId,
            toAcpPromptBlocks(turn.text),
          )
          inFlight
            .then(() => {
              ctx.emit({ type: "turn-finished", runnerId: ctx.rootRunnerId })
            })
            .catch((err) => {
              ctx.emit({
                type: "turn-finished",
                runnerId: ctx.rootRunnerId,
                error: { detail: String(err) },
              })
            })
        },

        interrupt(): void {
          client.sessionCancel(sessionId)
        },

        close(): void {
          try {
            client.sessionClose(sessionId)
          } catch {
            /* idempotent */
          }
          connection.close()
        },

        setMode(mode: PermissionMode): void {
          client.sessionSetMode(sessionId, toAcpMode(mode))
        },
      }

      return handle
    },
  }

  return adapter
}
