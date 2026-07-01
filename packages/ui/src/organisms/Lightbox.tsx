import type { AttachmentKind } from "@spectrum/agent-events"
import type { ReactElement } from "react"
import { Modal } from "../atoms/Modal"

export type LightboxProps = {
  readonly open: boolean
  readonly title: string
  readonly kind: AttachmentKind
  readonly dataUrl?: string
  readonly onClose: () => void
}

const decodeDataUrlText = (dataUrl: string): string => {
  const m = dataUrl.match(/^data:[^;]*;base64,(.*)$/)
  if (m === null || m[1] === undefined) return ""
  try {
    return Buffer.from(m[1], "base64").toString("utf-8")
  } catch {
    return ""
  }
}

export const Lightbox = ({
  open,
  title,
  kind,
  dataUrl,
  onClose,
}: LightboxProps): ReactElement | null => {
  if (!open || dataUrl === undefined) return null
  return (
    <Modal title={title} open={open} onClose={onClose}>
      {kind === "image" ? (
        <img className="lk-lightbox__image" src={dataUrl} alt={title} />
      ) : kind === "text" ? (
        <pre data-testid="lightbox-text" className="lk-lightbox__text">
          {decodeDataUrlText(dataUrl)}
        </pre>
      ) : (
        <p>This file type opens in your system viewer.</p>
      )}
    </Modal>
  )
}
