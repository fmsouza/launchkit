import type { AttachmentRef } from "@spectrum/agent-events"
import { type ReactElement, useId } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { AttachmentTray } from "./AttachmentTray"

export type MessageBubbleProps = {
  readonly text: string
  /** Message author. Named `author` (not `role`) so it isn't mistaken for the ARIA `role` attribute. */
  readonly author?: "user" | "assistant"
  /** Set when the message carries a turn error (e.g. a provider failure) — renders the error state. */
  readonly tone?: "error"
  /**
   * Delivery state for an optimistic user send: "sending" = awaiting the backend echo;
   * "failed" = it never landed (crash/transport/timeout). Failed/errored bubbles render actions.
   */
  readonly status?: "sending" | "failed"
  /** Re-dispatch this prompt. Rendered (with Cancel) when the bubble is failed/errored. */
  readonly onResend?: () => void
  /** Discard this failed send and restore its text to the composer. */
  readonly onCancel?: () => void
  /**
   * Open a link in the OS default browser. `preventDefault()` always runs so the SPA webview never
   * navigates in-window. When omitted, links render but do nothing on click.
   */
  readonly onOpenLink?: (url: string) => void
  /** Read-only attachments carried by this user message. Assistant bubbles never carry attachments. */
  readonly attachments?: readonly AttachmentRef[]
  /** Open an attachment (open the file in the OS, open the image in a viewer, etc). */
  readonly onOpenAttachment?: (ref: AttachmentRef) => void
}

/**
 * A chat message. `author` drives alignment via `data-role`. `status="sending"` dims the bubble;
 * `status="failed"` or `tone="error"` renders an alert. When failed/errored, renders Resend/Cancel.
 * Body is GitHub-flavored Markdown (no innerHTML — CSP-safe).
 */
export const MessageBubble = ({
  text,
  author = "assistant",
  tone,
  status,
  onResend,
  onCancel,
  onOpenLink,
  attachments,
  onOpenAttachment,
}: MessageBubbleProps): ReactElement => {
  const msgId = useId()
  const failed = tone === "error" || status === "failed"
  const hasNewActions = onResend !== undefined || onCancel !== undefined
  return (
    <div
      className="lk-message-bubble"
      data-role={author}
      {...(tone === "error" ? { "data-tone": "error" } : {})}
      {...(status !== undefined ? { "data-status": status } : {})}
      {...(failed ? { role: "alert" } : {})}
    >
      {author === "user" &&
      attachments !== undefined &&
      attachments.length > 0 ? (
        <AttachmentTray
          attachments={attachments}
          {...(onOpenAttachment !== undefined
            ? { onOpen: onOpenAttachment }
            : {})}
        />
      ) : null}
      <div id={msgId} className="lk-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                title={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href !== undefined && onOpenLink !== undefined) {
                    onOpenLink(href)
                  }
                }}
              >
                {children}
              </a>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
      {failed && hasNewActions ? (
        <div className="lk-message-bubble__actions">
          {onResend !== undefined ? (
            <button
              type="button"
              className="lk-message-bubble__resend"
              aria-describedby={msgId}
              onClick={() => onResend()}
            >
              Resend
            </button>
          ) : null}
          {onCancel !== undefined ? (
            <button
              type="button"
              className="lk-message-bubble__cancel"
              aria-describedby={msgId}
              onClick={() => onCancel()}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
