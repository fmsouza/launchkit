import type {
  AttachmentCapabilities,
  AttachmentKind,
  AttachmentRef,
  AttachmentRefWithBytes,
} from "@spectrum/agent-events"
import { acceptedMimesFromCapabilities } from "@spectrum/agent-events"
import { useCallback, useState } from "react"
import { useIpcClient } from "../IpcClientContext"
import type { NotificationInput } from "../stores/notifications-model"

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
 * (image/text vs pdf/binary). The `notify` callback is page-owned so the
 * hook never reaches into global state and stays trivially testable.
 */
export const useUploads = (
  caps: AttachmentCapabilities | undefined,
  onOpen: (ref: AttachmentRef, dataUrl: string | null) => void,
  notify: (input: NotificationInput) => void,
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
    if (!res.ok) {
      notify({ tone: "warning", message: "Couldn't open the file picker" })
      return
    }
    const { uploads, rejected, errors } = res.value
    // Surface per-file failures (rejections + IO errors) as toasts so the user
    // knows each missing file wasn't attached — see docs/01-conventions/notifications.md.
    for (const r of rejected ?? []) {
      notify({ tone: "warning", message: `Couldn't attach ${r.displayName}` })
    }
    for (const e of errors ?? []) {
      notify({
        tone: "warning",
        message:
          e.reason === "too-large"
            ? `Couldn't attach ${e.displayName} (too large)`
            : `Couldn't read ${e.displayName}`,
      })
    }
    if (uploads.length > 0) setPending((p) => [...p, ...uploads])
    // Resolve thumbnails for image uploads (fire-and-forget per ref).
    for (const u of uploads) {
      if (u.kind !== "image") continue
      const t = await ipcClient.readUploadThumbnail({ id: u.id, mime: u.mime })
      if (t.ok && t.value.dataUrl !== undefined) {
        setThumbnails((m) => new Map(m).set(u.id, t.value.dataUrl as string))
      }
    }
  }, [caps, ipcClient, notify])

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
