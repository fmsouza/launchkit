import type { AgentStartInput } from "@spectrum/agent-driver"
import type { ApprovalTarget, AttachmentRef } from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import { mapOpenclawEvent, newOpenclawMapState } from "./map-openclaw-event"
import type {
  OpenClawEvent,
  OpenclawConnect,
  OpenclawConnectConfig,
} from "./transport"

/** Env keys the fixed builtin renders for the gateway connection (Task 5). */
const ENV_URL = "OPENCLAW_GATEWAY_URL"
const ENV_TOKEN = "OPENCLAW_GATEWAY_TOKEN"
const ENV_AGENT = "OPENCLAW_AGENT_ID"
const ENV_MODEL = "OPENCLAW_MODEL"

export interface OpenclawAdapterDeps {
  /** Connect to the Gateway (injected; real impl UNVERIFIED — no binary). */
  readonly connect: OpenclawConnect
}

const readConfig = (input: AgentStartInput): OpenclawConnectConfig => {
  const url = input.env[ENV_URL] ?? "ws://127.0.0.1:18789"
  const token = input.env[ENV_TOKEN] ?? ""
  const agentId = input.env[ENV_AGENT] ?? "default"
  const model = input.env[ENV_MODEL]
  return {
    url,
    token,
    agentId,
    cwd: input.cwd,
    ...(model !== undefined ? { model } : {}),
  }
}

const approvalTarget = (
  e: Extract<OpenClawEvent, { event: "exec.approval.requested" }>,
): ApprovalTarget => ({
  kind: e.payload.kind ?? "command",
  detail: e.payload.detail,
})

/**
 * OpenClaw's transport only takes plain text, so a Turn with attachments degrades
 * to a text-only note: each attachment appends `[attachment: <displayName>]`. The
 * capability gate upstream hides the picker for OpenClaw, so this is a safety net.
 */
const appendAttachmentNote = (
  text: string,
  refs: readonly AttachmentRef[],
): string => {
  if (refs.length === 0) return text
  const notes = refs.map((r) => `[attachment: ${r.displayName}]`).join(" ")
  return `${text}\n${notes}`
}

/**
 * The OpenClaw adapter. `start` connects to the Gateway, starts a run for the initial prompt, drains the
 * normalized event stream into ctx.emit(mapOpenclawEvent(...)), bridges exec approvals via ctx.requestApproval,
 * and returns a control handle. The stream drain runs detached (fire-and-forget) — errors surface as a
 * runner-finished(errored) the runtime already emits on a rejected start, and the mapper emits run.failed/error.
 *
 * Approval ownership: the runtime's `ctx.requestApproval` OWNS the canonical `approval-requested` emit (with a
 * fresh runtime requestId the UI answers via respondApproval). The adapter therefore SUPPRESSES the mapper's
 * own `approval-requested` for `exec.approval.requested` (it would be a duplicate carrying the un-answerable
 * gateway approvalId), and instead bridges through ctx.requestApproval, then resolves the gateway by approvalId.
 *
 * UNVERIFIED: built to the documented Gateway WS protocol; no openclaw binary / published @openclaw/sdk to run.
 */
export const createOpenclawAdapter = (
  deps: OpenclawAdapterDeps,
): DriverAdapter => ({
  start: async (input, ctx: AdapterCtx): Promise<AdapterHandle> => {
    const config = readConfig(input)
    const transport = await deps.connect(config)
    const sessionKey = ctx.rootRunnerId as unknown as string // 1:1 root session<->run; the Gateway assigns
    const run = transport.run({ sessionKey, input: input.initialPrompt ?? "" })
    const state = newOpenclawMapState({
      rootRunnerId: ctx.rootRunnerId,
      newRunnerId: ctx.newRunnerId,
    })

    // Detached drain of the normalized event stream.
    void (async () => {
      for await (const event of run.events()) {
        if (event.event === "exec.approval.requested") {
          // The runtime's requestApproval owns the canonical approval-requested emit; do NOT also emit the
          // mapper's (it would duplicate with the gateway approvalId the UI cannot answer).
          const decision = await ctx.requestApproval(
            ctx.rootRunnerId,
            approvalTarget(event),
          )
          run.resolveApproval(
            event.payload.approvalId,
            decision === "deny" ? "deny" : "allow",
          )
          continue
        }
        for (const canonical of mapOpenclawEvent(event, state))
          ctx.emit(canonical)
      }
    })()

    return {
      // Task 6: OpenClaw's transport is text-only; attachment metadata degrades to a
      // "[attachment: name]" note appended to the text. The capability gate upstream
      // hides the picker for OpenClaw, so this is a safety net only.
      send: (turn) =>
        transport.send({
          sessionKey,
          text: appendAttachmentNote(turn.text, turn.attachments ?? []),
        }),
      interrupt: () => run.cancel(),
      close: () => {
        run.close()
        transport.disconnect()
      },
      // OpenClaw exposes no reasoning-effort knob today; accept the tier so the seam is uniform
      // and the UI selector is harmless. No-op by design.
      setThinkingEffort: () => {},
    }
  },
  // OpenClaw has no native attachment support today; declare all-false so the
  // upstream capability gate hides the picker. The text-note fallback above
  // remains as a safety net for defensive calls.
  supportedAttachments: { image: false, pdf: false, binary: false },
})
