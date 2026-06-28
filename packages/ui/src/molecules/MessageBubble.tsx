import { type ReactElement, useId } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
  /** Legacy single retry (provider-error). Superseded by onResend/onCancel; removed in Task 16. */
  readonly onRetry?: () => void
  /** Re-dispatch this prompt. Rendered (with Cancel) when the bubble is failed/errored. */
  readonly onResend?: () => void
  /** Discard this failed send and restore its text to the composer. */
  readonly onCancel?: () => void
  /**
   * Open a link in the OS default browser. `preventDefault()` always runs so the SPA webview never
   * navigates in-window. When omitted, links render but do nothing on click.
   */
  readonly onOpenLink?: (url: string) => void
}

/**
 * A chat message. `author` drives alignment via `data-role`. `status="sending"` dims the bubble;
 * `status="failed"` or `tone="error"` renders an alert. When failed/errored, prefers Resend/Cancel
 * (new) and falls back to the legacy Retry. Body is GitHub-flavored Markdown (no innerHTML — CSP-safe).
 */
export const MessageBubble = ({
  text,
  author = "assistant",
  tone,
  status,
  onRetry,
  onResend,
  onCancel,
  onOpenLink,
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
      ) : failed && onRetry !== undefined ? (
        <button
          type="button"
          className="lk-message-bubble__retry"
          aria-describedby={msgId}
          onClick={() => onRetry()}
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
