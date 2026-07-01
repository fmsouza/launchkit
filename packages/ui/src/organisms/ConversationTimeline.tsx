import { isTaskTool } from "@spectrum/agent-events"
import type {
  ApprovalDecision,
  AttachmentRef,
  MessageItem,
  QuestionAnswer,
  RunnerId,
  RunnerState,
} from "@spectrum/agent-events"
import { type ReactElement, useState } from "react"
import { ApprovalCard } from "../molecules/ApprovalCard"
import { FileDiffCard } from "../molecules/FileDiffCard"
import { MessageBubble } from "../molecules/MessageBubble"
import { QuestionCard } from "../molecules/QuestionCard"
import { ReasoningBlock } from "../molecules/ReasoningBlock"
import { SubRunnerCard } from "../molecules/SubRunnerCard"
import { ToolCallCard } from "../molecules/ToolCallCard"
import { UsageFooter } from "../molecules/UsageFooter"
import { subRunnerDetail } from "../molecules/subRunnerDetail"

export type ConversationTimelineProps = {
  readonly runner: RunnerState
  readonly runners: ReadonlyMap<RunnerId, RunnerState>
  readonly onOpenSubRunner: (id: RunnerId) => void
  readonly onDecide: (requestId: string, decision: ApprovalDecision) => void
  readonly onAnswer: (requestId: string, answer: QuestionAnswer) => void
  readonly inert?: boolean
  /** Open a chat link in the OS browser; threaded to each `MessageBubble`. */
  readonly onOpenLink?: (url: string) => void
  /** Open a message attachment (image, file, etc). Threaded to user-bubble trays. */
  readonly onOpenAttachment?: (ref: AttachmentRef) => void
  /** Optimistic / failed sends not yet reconciled with the backend echo. Rendered after the feed. */
  readonly pending?: readonly {
    readonly clientSendId: string
    readonly text: string
    /** Attachment refs (no bytes — the dataUrl is send-only). */
    readonly attachments?: readonly AttachmentRef[]
    readonly status: "sending" | "failed"
  }[]
  /** Re-dispatch a prompt (failed pending send, or the last errored turn). */
  readonly onResend?: (entry: { clientSendId?: string; text: string }) => void
  /** Discard a failed send + restore its text to the composer. */
  readonly onCancel?: (entry: { clientSendId?: string; text: string }) => void
  /** Suppress the Resend/Cancel footer on this errored message id (it was dismissed via Cancel). */
  readonly dismissedErrorId?: string
}

export const ConversationTimeline = ({
  runner,
  runners,
  onOpenSubRunner,
  onDecide,
  onAnswer,
  inert = false,
  onOpenLink,
  onOpenAttachment,
  pending,
  onResend,
  onCancel,
  dismissedErrorId,
}: ConversationTimelineProps): ReactElement => {
  // Per-item expand state lives here (the page-level store holds RunState, not
  // ephemeral toggle bits): collapsed ids that the user has opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const visible = runner.items.filter(
    (item) => !(item.kind === "tool-call" && isTaskTool(item.tool)),
  )
  const lastUserPrompt = runner.items.findLast(
    (i): i is MessageItem => i.kind === "message" && i.role === "user",
  )?.text

  return (
    <div className="lk-timeline" data-runner={runner.id}>
      {visible.map((item, i) => {
        switch (item.kind) {
          case "message": {
            const isLastError =
              i === visible.length - 1 &&
              item.tone === "error" &&
              item.messageId !== dismissedErrorId &&
              lastUserPrompt !== undefined
            return (
              <MessageBubble
                key={`m-${item.messageId}`}
                text={item.text}
                author={item.role}
                {...(item.attachments === undefined
                  ? {}
                  : { attachments: item.attachments })}
                {...(item.tone !== undefined ? { tone: item.tone } : {})}
                {...(isLastError && onResend !== undefined
                  ? { onResend: () => onResend({ text: lastUserPrompt }) }
                  : {})}
                {...(isLastError && onCancel !== undefined
                  ? { onCancel: () => onCancel({ text: lastUserPrompt }) }
                  : {})}
                {...(onOpenLink === undefined ? {} : { onOpenLink })}
                {...(onOpenAttachment === undefined
                  ? {}
                  : { onOpenAttachment })}
              />
            )
          }
          case "reasoning":
            return (
              <ReasoningBlock
                key={`r-${item.messageId}`}
                text={item.text}
                expanded={expanded.has(item.messageId)}
                onToggle={() => toggle(item.messageId)}
              />
            )
          case "tool-call": {
            if (item.spawnedRunnerId !== undefined) {
              const childRunner = runners.get(item.spawnedRunnerId)
              const detail = subRunnerDetail(item.spawnedRunnerId, runners)
              return (
                <SubRunnerCard
                  key={`s-${item.callId}`}
                  runnerId={item.spawnedRunnerId}
                  title="Agent"
                  {...(detail === undefined ? {} : { detail })}
                  status={childRunner?.status ?? "running"}
                  onOpen={onOpenSubRunner}
                />
              )
            }
            return (
              <ToolCallCard
                key={`c-${item.callId}`}
                item={item}
                expanded={expanded.has(item.callId)}
                onToggle={() => toggle(item.callId)}
              />
            )
          }
          case "file-change":
            return <FileDiffCard key={`f-${i}-${item.path}`} item={item} />
          case "approval":
            return (
              <ApprovalCard
                key={`a-${item.requestId}`}
                item={item}
                inert={inert}
                onDecide={(d) => onDecide(item.requestId, d)}
              />
            )
          case "question":
            return (
              <QuestionCard
                key={`q-${item.requestId}`}
                item={item}
                inert={inert}
                onAnswer={(a) => onAnswer(item.requestId, a)}
              />
            )
          default: {
            const _exhaustive: never = item
            return _exhaustive
          }
        }
      })}
      {(pending ?? []).map((p) => (
        <MessageBubble
          key={`p-${p.clientSendId}`}
          text={p.text}
          author="user"
          status={p.status}
          {...(p.attachments === undefined
            ? {}
            : { attachments: p.attachments })}
          {...(p.status === "failed" && onResend !== undefined
            ? {
                onResend: () =>
                  onResend({ clientSendId: p.clientSendId, text: p.text }),
              }
            : {})}
          {...(p.status === "failed" && onCancel !== undefined
            ? {
                onCancel: () =>
                  onCancel({ clientSendId: p.clientSendId, text: p.text }),
              }
            : {})}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onOpenAttachment === undefined ? {} : { onOpenAttachment })}
        />
      ))}
      {runner.usage === undefined ? null : <UsageFooter usage={runner.usage} />}
    </div>
  )
}
