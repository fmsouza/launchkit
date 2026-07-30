import type { CanonicalEvent } from "@spectrum/agent-events"
import type { RunnerId } from "@spectrum/types"
import type { AcpMapState, AcpSessionUpdateNotification } from "./acp-client"

export type { AcpMapState }

const text = (content: unknown): string => {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>
    if (c.type === "text" && typeof c.text === "string") return c.text
  }
  return ""
}

const flattenToolContent = (
  content: readonly unknown[] | undefined,
): string => {
  if (content === undefined) return ""
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const i = item as Record<string, unknown>
      if (i.type === "content") {
        const inner = i.content
        if (typeof inner === "object" && inner !== null) {
          const c = inner as Record<string, unknown>
          if (c.type === "text" && typeof c.text === "string")
            parts.push(c.text)
        }
      }
    }
  }
  return parts.join("\n")
}

const runnerId = (
  _notif: AcpSessionUpdateNotification,
  state: AcpMapState,
): RunnerId => state.rootRunnerId

const synthesizeMessageId = (state: AcpMapState, prefix: string): string => {
  // ACP v1 stabilized optional Agent-generated message IDs; when absent, synthesize one.
  return `${prefix}_${state.rootRunnerId}`
}

/**
 * Pure mapper: maps ONE ACP `session/update` notification to 0..n `CanonicalEvent`s.
 * Deterministic given the same `AcpMapState`; mutates only the state's correlation sets/counters.
 * No IO, no logging.
 */
export const mapAcpUpdate = (
  notif: AcpSessionUpdateNotification,
  state: AcpMapState,
): CanonicalEvent[] => {
  const { update } = notif
  const runnerIdValue = runnerId(notif, state)

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const t = text(update.content)
      if (t === "") return []
      const messageId = update.messageId ?? synthesizeMessageId(state, "msg")
      return [
        {
          type: "text-delta",
          runnerId: runnerIdValue,
          messageId,
          text: t,
          role: "assistant",
        },
      ]
    }

    case "thought": {
      const t = text(update.content)
      if (t === "") return []
      const messageId =
        update.messageId ?? synthesizeMessageId(state, "thought")
      return [
        {
          type: "reasoning-delta",
          runnerId: runnerIdValue,
          messageId,
          text: t,
        },
      ]
    }

    case "tool_call": {
      const { toolCallId } = update
      if (toolCallId === "") return []
      // Dedup: a re-emitted tool_call with the same toolCallId should not double-start.
      if (state.startedToolCalls.has(toolCallId)) return []
      state.startedToolCalls.add(toolCallId)
      const tool = update.title ?? update.kind ?? "tool"
      const input = update.rawInput
      const event: CanonicalEvent = {
        type: "tool-call-started",
        runnerId: runnerIdValue,
        callId: toolCallId,
        tool,
      }
      if (input !== undefined) {
        ;(
          event as Extract<CanonicalEvent, { type: "tool-call-started" }>
        ).input = input
      }
      return [event]
    }

    case "tool_call_update": {
      const { toolCallId, status } = update
      if (status === "in_progress") {
        // Stream content as tool-output-delta.
        const chunk = flattenToolContent(update.content)
        if (chunk === "") return []
        return [
          {
            type: "tool-output-delta",
            runnerId: runnerIdValue,
            callId: toolCallId,
            chunk,
          },
        ]
      }
      if (status === "completed") {
        const output = flattenToolContent(update.content)
        const event: CanonicalEvent = {
          type: "tool-call-finished",
          runnerId: runnerIdValue,
          callId: toolCallId,
          status: "ok",
        }
        if (output !== "") {
          ;(
            event as Extract<CanonicalEvent, { type: "tool-call-finished" }>
          ).output = output
        }
        if (update.rawOutput !== undefined) {
          ;(
            event as Extract<CanonicalEvent, { type: "tool-call-finished" }>
          ).result = update.rawOutput
        }
        return [event]
      }
      if (status === "failed") {
        const output = flattenToolContent(update.content)
        const event: CanonicalEvent = {
          type: "tool-call-finished",
          runnerId: runnerIdValue,
          callId: toolCallId,
          status: "error",
        }
        if (output !== "") {
          ;(
            event as Extract<CanonicalEvent, { type: "tool-call-finished" }>
          ).output = output
        }
        return [event]
      }
      // No status or pending — no event (the tool_call itself already emitted tool-call-started).
      return []
    }

    case "plan": {
      const planId = `plan-${state.rootRunnerId}-${state.planCounter}`
      state.planCounter += 1
      return [
        {
          type: "plan-update",
          runnerId: runnerIdValue,
          planId,
          entries: update.entries.map((e) => ({
            content: e.content,
            ...(e.priority !== undefined ? { priority: e.priority } : {}),
            status: e.status,
          })),
        },
      ]
    }

    case "usage_update": {
      if (update.used === null && update.size === null) return []
      const usage: CanonicalEvent = {
        type: "usage",
        runnerId: runnerIdValue,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          ...(update.used !== null ? { contextUsed: update.used } : {}),
          ...(update.size !== null ? { contextSize: update.size } : {}),
          ...(update.cost !== undefined ? { costUsd: update.cost.amount } : {}),
        },
      }
      return [usage]
    }

    case "mode": {
      return [
        {
          type: "annotation",
          runnerId: runnerIdValue,
          kind: "mode-change",
          data: update.mode ?? null,
        },
      ]
    }

    default:
      // Unknown sessionUpdate kind — defensive, return no events.
      return []
  }
}
