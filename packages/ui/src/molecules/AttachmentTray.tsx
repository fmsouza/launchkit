import type { AttachmentRef } from "@spectrum/agent-events"
import type { ReactElement } from "react"
import { AttachmentChip } from "./AttachmentChip"

export type AttachmentTrayProps = {
  readonly attachments: readonly AttachmentRef[]
  readonly thumbnails?: ReadonlyMap<string, string>
  readonly onRemove?: (id: string) => void
  readonly onOpen?: (ref: AttachmentRef) => void
}

export const AttachmentTray = ({
  attachments,
  thumbnails,
  onRemove,
  onOpen,
}: AttachmentTrayProps): ReactElement | null => {
  if (attachments.length === 0) return null
  return (
    <div className="lk-attachment-tray">
      {attachments.map((a) => {
        const thumb = thumbnails?.get(a.id)
        return (
          <AttachmentChip
            key={a.id}
            ref={a}
            {...(thumb !== undefined ? { thumbnailUrl: thumb } : {})}
            {...(onRemove !== undefined ? { onRemove } : {})}
            {...(onOpen !== undefined ? { onOpen } : {})}
          />
        )
      })}
    </div>
  )
}
