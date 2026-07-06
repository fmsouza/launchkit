import type {
  AttachmentCapabilities,
  AttachmentKind,
  AttachmentRef,
  AttachmentRefWithBytes,
} from "@spectrum/agent-events"
import {
  MAX_UPLOAD_BYTES,
  acceptedMimesFromCapabilities,
} from "@spectrum/agent-events"
import { useCallback, useEffect, useState } from "react"
import { useIpcClient } from "../IpcClientContext"
import type { NotificationInput } from "../stores/notifications-model"

export type UseUploads = {
  readonly pending: readonly AttachmentRef[]
  readonly thumbnails: ReadonlyMap<string, string>
  readonly pick: () => Promise<void>
  /** Stage files DROPPED on the composer — same canonical pipeline as `pick`. */
  readonly addFiles: (files: readonly File[]) => Promise<void>
  readonly remove: (id: string) => void
  readonly clear: () => void
  readonly open: (ref: AttachmentRef) => void
  /** Resolve dataUrls for the send path; returns refs-with-bytes ready for the run-send Turn. */
  readonly resolveForSend: () => Promise<AttachmentRefWithBytes[]>
}

/** Strip the `data:<mime>;base64,` prefix from a FileReader data URL. Pure. */
export const base64FromDataUrl = (dataUrl: string): string => {
  const comma = dataUrl.indexOf(",")
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/**
 * Read a File's bytes as base64 via FileReader (the webview has no Node
 * Buffer, and readAsDataURL avoids hand-rolled base64 over large buffers).
 * Rejects for unreadable entries — notably dropped directories.
 */
const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result)))
    try {
      reader.readAsDataURL(file)
    } catch (e) {
      reject(e)
    }
  })

const acceptedKindsFromCaps = (
  caps: AttachmentCapabilities,
): AttachmentKind[] => {
  const kinds: AttachmentKind[] = []
  if (caps.image) kinds.push("image")
  if (caps.pdf) kinds.push("pdf")
  if (caps.binary) kinds.push("text", "binary")
  return kinds
}

/** One dropped file's wire payload for `saveDroppedUploads`. */
type DroppedFilePayload = {
  readonly displayName: string
  readonly mime: string
  readonly dataBase64: string
}

/** The shared `pickUploads`/`saveDroppedUploads` result shape (one post-ingest path). */
type UploadIngestOutcome = {
  readonly uploads: readonly AttachmentRef[]
  readonly rejected?:
    | readonly { displayName: string; reason: "unsupported-kind" }[]
    | undefined
  readonly errors?:
    | readonly { displayName: string; reason: "io-failed" | "too-large" }[]
    | undefined
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

  /**
   * Canonical post-ingest application shared by the picker and drag-and-drop:
   * toast every per-file failure, stage new refs (deduped by content id so
   * re-attaching the same file never duplicates a chip), then resolve image
   * thumbnails CONCURRENTLY.
   */
  const applyIngest = useCallback(
    async (result: UploadIngestOutcome): Promise<void> => {
      // Surface per-file failures (rejections + IO errors) as toasts so the user
      // knows each missing file wasn't attached — see docs/01-conventions/notifications.md.
      for (const r of result.rejected ?? []) {
        notify({ tone: "warning", message: `Couldn't attach ${r.displayName}` })
      }
      for (const e of result.errors ?? []) {
        notify({
          tone: "warning",
          message:
            e.reason === "too-large"
              ? `Couldn't attach ${e.displayName} (too large)`
              : `Couldn't read ${e.displayName}`,
        })
      }
      if (result.uploads.length > 0) {
        setPending((p) => {
          const seen = new Set(p.map((a) => a.id))
          const fresh: AttachmentRef[] = []
          for (const u of result.uploads) {
            if (seen.has(u.id)) continue
            seen.add(u.id)
            fresh.push(u)
          }
          return fresh.length === 0 ? p : [...p, ...fresh]
        })
      }
      // Thumbnails resolve concurrently; re-fetching a deduped id is an
      // idempotent map write, so no cross-check with `pending` is needed.
      await Promise.all(
        result.uploads
          .filter((u) => u.kind === "image")
          .map(async (u) => {
            const t = await ipcClient.readUploadThumbnail({
              id: u.id,
              mime: u.mime,
            })
            if (t.ok && t.value.dataUrl !== undefined) {
              setThumbnails((m) =>
                new Map(m).set(u.id, t.value.dataUrl as string),
              )
            }
          }),
      )
    },
    [ipcClient, notify],
  )

  const pick = useCallback(async () => {
    if (caps === undefined) return
    const res = await ipcClient.pickUploads({
      acceptedMimes: acceptedMimesFromCapabilities(caps),
      acceptedKinds: acceptedKindsFromCaps(caps),
    })
    if (!res.ok) {
      notify({ tone: "warning", message: "Couldn't open the file picker" })
      return
    }
    await applyIngest(res.value)
  }, [caps, ipcClient, notify, applyIngest])

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (caps === undefined || files.length === 0) return
      // Client-side pre-checks: skip oversize files without reading/shipping
      // their bytes (the store re-enforces the same MAX_UPLOAD_BYTES), and
      // surface unreadable entries (dropped folders) as per-file toasts.
      // Kind filtering stays bun-side — ONE canonical validator (ingestUploads).
      const read = await Promise.all(
        files.map(async (file): Promise<DroppedFilePayload | null> => {
          if (file.size > MAX_UPLOAD_BYTES) {
            notify({
              tone: "warning",
              message: `Couldn't attach ${file.name} (too large)`,
            })
            return null
          }
          try {
            return {
              displayName: file.name,
              mime: file.type,
              dataBase64: await readFileAsBase64(file),
            }
          } catch {
            notify({ tone: "warning", message: `Couldn't read ${file.name}` })
            return null
          }
        }),
      )
      const payload = read.filter((f): f is DroppedFilePayload => f !== null)
      if (payload.length === 0) return
      const res = await ipcClient.saveDroppedUploads({
        files: payload,
        acceptedKinds: acceptedKindsFromCaps(caps),
      })
      if (!res.ok) {
        notify({ tone: "warning", message: "Couldn't attach files" })
        return
      }
      await applyIngest(res.value)
    },
    [caps, ipcClient, notify, applyIngest],
  )

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
    const resolved = await Promise.all(
      pending.map(async (a): Promise<AttachmentRefWithBytes | null> => {
        const r = await ipcClient.readUploadDataUrl({ id: a.id, mime: a.mime })
        return r.ok && r.value.dataUrl !== undefined
          ? { ...a, dataUrl: r.value.dataUrl as string }
          : null
      }),
    )
    return resolved.filter((a): a is AttachmentRefWithBytes => a !== null)
  }, [pending, ipcClient])

  const open = useCallback(
    (ref: AttachmentRef) => {
      // Defer to the page-level resolver — it knows whether to show a
      // lightbox (image/text) or call openUploadExternal (pdf/binary).
      onOpen(ref, null)
    },
    [onOpen],
  )

  // Capability narrowing (e.g. the user switched to a non-vision model):
  // staged refs of now-unsupported kinds are removed, one warning toast each,
  // so the tray never advertises files that can no longer be sent.
  useEffect(() => {
    if (caps === undefined) return
    const allowed = (k: AttachmentKind): boolean =>
      k === "image" ? caps.image : k === "pdf" ? caps.pdf : caps.binary
    const orphaned = pending.filter((a) => !allowed(a.kind))
    if (orphaned.length === 0) return
    for (const a of orphaned) {
      notify({
        tone: "warning",
        message: `Removed ${a.displayName} — the selected model can't receive ${
          a.kind === "pdf" ? "PDFs" : `${a.kind}s`
        }`,
      })
    }
    setPending((p) => p.filter((a) => allowed(a.kind)))
    setThumbnails((m) => {
      const n = new Map(m)
      for (const a of orphaned) n.delete(a.id)
      return n
    })
  }, [caps, pending, notify])

  return {
    pending,
    thumbnails,
    pick,
    addFiles,
    remove,
    clear,
    open,
    resolveForSend,
  }
}
