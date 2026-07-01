import type {
  AttachmentCapabilities,
  AttachmentKind,
  AttachmentRef,
  AttachmentRefWithBytes,
} from "@spectrum/agent-events"
import { acceptedMimesFromCapabilities } from "@spectrum/agent-events"
import { useCallback, useState } from "react"
import { useIpcClient } from "../IpcClientContext"

export type UseUploads = {
  readonly pending: readonly AttachmentRef[]
  readonly thumbnails: ReadonlyMap<string, string>
  readonly pick: () => Promise<void>
  readonly remove: (id: string) => void
  readonly clear: () => void
  readonly open: (ref: AttachmentRef) => void
  /** Resolve dataUrls for the send path; returns refs-with-bytes ready for the run-send Turn. */
  readonly resolveForSend: () => Promise<AttachmentRefWithBytes[]>
}

/**
 * Composer-scoped attachment state: holds the user's picked `AttachmentRef`s,
 * resolves image thumbnails, and produces `AttachmentRefWithBytes[]` on send
 * (the dataUrl is send-only — never persisted). The `onOpen` resolver is
 * page-owned because the page decides lightbox vs external-app dispatch
 * (image/text vs pdf/binary).
 */
export const useUploads = (
  caps: AttachmentCapabilities | undefined,
  onOpen: (ref: AttachmentRef, dataUrl: string | null) => void,
): UseUploads => {
  const ipcClient = useIpcClient()
  const [pending, setPending] = useState<readonly AttachmentRef[]>([])
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())

  const pick = useCallback(async () => {
    if (caps === undefined) return
    const acceptedMimes = acceptedMimesFromCapabilities(caps)
    const acceptedKinds: AttachmentKind[] = []
    if (caps.image) acceptedKinds.push("image")
    if (caps.pdf) acceptedKinds.push("pdf")
    if (caps.binary) acceptedKinds.push("text", "binary")
    const res = await ipcClient.pickUploads({ acceptedMimes, acceptedKinds })
    if (!res.ok) return
    const { uploads } = res.value
    if (uploads.length > 0) setPending((p) => [...p, ...uploads])
    // Resolve thumbnails for image uploads (fire-and-forget per ref).
    for (const u of uploads) {
      if (u.kind !== "image") continue
      const t = await ipcClient.readUploadThumbnail({ id: u.id, mime: u.mime })
      if (t.ok && t.value.dataUrl !== undefined) {
        setThumbnails((m) => new Map(m).set(u.id, t.value.dataUrl as string))
      }
    }
  }, [caps, ipcClient])

  const remove = useCallback((id: string) => {
    setPending((p) => p.filter((a) => a.id !== id))
    setThumbnails((m) => {
      const n = new Map(m)
      n.delete(id)
      return n
    })
  }, [])

  const clear = useCallback(() => {
    setPending([])
    setThumbnails(new Map())
  }, [])

  const resolveForSend = useCallback(async (): Promise<
    AttachmentRefWithBytes[]
  > => {
    const out: AttachmentRefWithBytes[] = []
    for (const a of pending) {
      const r = await ipcClient.readUploadDataUrl({ id: a.id, mime: a.mime })
      if (r.ok && r.value.dataUrl !== undefined) {
        out.push({ ...a, dataUrl: r.value.dataUrl as string })
      }
    }
    return out
  }, [pending, ipcClient])

  const open = useCallback(
    (ref: AttachmentRef) => {
      // Defer to the page-level resolver — it knows whether to show a
      // lightbox (image/text) or call openUploadExternal (pdf/binary).
      onOpen(ref, null)
    },
    [onOpen],
  )

  return { pending, thumbnails, pick, remove, clear, open, resolveForSend }
}
