import type { AttachmentRef } from "@spectrum/agent-events"
import type { KeyboardEvent, ReactElement } from "react"
import { Icon } from "../atoms/Icon"

export type AttachmentChipProps = {
  readonly ref: AttachmentRef
  readonly thumbnailUrl?: string
  /** When set, the chip is removable (composer pending tray). When absent, read-only (history). */
  readonly onRemove?: (id: string) => void
  readonly onOpen?: (ref: AttachmentRef) => void
}

const placeholderIcon = (
  kind: AttachmentRef["kind"],
): "file" | "file-text" | "file-binary" => {
  if (kind === "text") return "file-text"
  if (kind === "binary") return "file-binary"
  return "file"
}

export const AttachmentChip = ({
  ref: attachment,
  thumbnailUrl,
  onRemove,
  onOpen,
}: AttachmentChipProps): ReactElement => {
  const isImage = attachment.kind === "image"
  return (
    <button
      type="button"
      data-testid="chip"
      className="lk-attachment-chip"
      aria-label={`Attachment: ${attachment.displayName}`}
      onClick={() => onOpen?.(attachment)}
    >
      <span className="lk-attachment-chip__thumb">
        {isImage && thumbnailUrl !== undefined ? (
          <img src={thumbnailUrl} alt={attachment.displayName} />
        ) : (
          <Icon name={placeholderIcon(attachment.kind)} size={20} />
        )}
      </span>
      <span
        className="lk-attachment-chip__label"
        title={attachment.displayName}
      >
        {attachment.displayName}
      </span>
      {onRemove !== undefined && (
        <span
          data-testid="chip-remove"
          className="lk-attachment-chip__remove-overlay"
          role="button"
          tabIndex={0}
          aria-label={`Remove ${attachment.displayName}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(attachment.id)
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              e.stopPropagation()
              onRemove(attachment.id)
            }
          }}
        />
      )}
    </button>
  )
}
