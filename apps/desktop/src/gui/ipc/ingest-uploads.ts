import type { AttachmentKind, AttachmentRef } from "@spectrum/agent-events"
import { MAX_UPLOAD_BYTES, inferKind } from "@spectrum/agent-events"
import type { Logger } from "@spectrum/logger"
import type { UploadStore } from "@spectrum/runtime-core"

/**
 * Tiny extension → MIME table for upload ingestion. The native picker's
 * `acceptedMimes` does the heavy lifting (the OS restricts the dialog to
 * matching files), but the resulting path may carry a name whose extension
 * the OS didn't classify. Defaults to `application/octet-stream` so the
 * resulting `AttachmentRef.mime` is always a non-empty, valid string the
 * renderer can round-trip.
 */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
}
export const mimeFromExt = (displayName: string): string => {
  const dot = displayName.lastIndexOf(".")
  if (dot === -1 || dot === displayName.length - 1) {
    return "application/octet-stream"
  }
  const ext = displayName.slice(dot + 1).toLowerCase()
  return EXTENSION_MIME[ext] ?? "application/octet-stream"
}

/** One file entering the upload store: a native path (picker) or in-memory bytes (drag-and-drop). */
export type UploadSource =
  | { readonly kind: "path"; readonly path: string }
  | {
      readonly kind: "bytes"
      readonly displayName: string
      /** Browser-reported MIME; empty/absent → inferred from the extension. */
      readonly mime?: string
      readonly data: Uint8Array
    }

export type IngestResult = {
  uploads: AttachmentRef[]
  rejected?: { displayName: string; reason: "unsupported-kind" }[]
  errors?: { displayName: string; reason: "io-failed" | "too-large" }[]
}

const displayNameOf = (source: UploadSource): string =>
  source.kind === "path"
    ? (source.path.split("/").pop() ?? source.path)
    : source.displayName

const mimeOf = (source: UploadSource, displayName: string): string =>
  source.kind === "bytes" && source.mime !== undefined && source.mime !== ""
    ? source.mime
    : mimeFromExt(displayName)

type PerFileOutcome = {
  upload?: AttachmentRef
  rejected?: { displayName: string; reason: "unsupported-kind" }
  error?: { displayName: string; reason: "io-failed" | "too-large" }
}

/**
 * Canonical upload ingestion shared by the native file picker and composer
 * drag-and-drop: kind-filter → size-cap → content-addressed store, every
 * source processed CONCURRENTLY with per-file failure isolation (one bad
 * file never blocks the rest). Results preserve input order. This is the
 * single place upload validation rules live — both IPC entry points
 * (`pickUploads`, `saveDroppedUploads`) delegate here.
 */
export const ingestUploads = async (params: {
  readonly sources: readonly UploadSource[]
  readonly acceptedKinds: readonly AttachmentKind[]
  readonly store: UploadStore
  readonly log: Logger
}): Promise<IngestResult> => {
  const { sources, acceptedKinds, store, log } = params
  const accepted = new Set<AttachmentKind>(acceptedKinds)
  const perFile = await Promise.all(
    sources.map(async (source): Promise<PerFileOutcome> => {
      const displayName = displayNameOf(source)
      const mime = mimeOf(source, displayName)
      const kind = inferKind(mime, displayName)
      if (!accepted.has(kind)) {
        return { rejected: { displayName, reason: "unsupported-kind" } }
      }
      const res =
        source.kind === "path"
          ? await store.save({
              sourcePath: source.path,
              mime,
              displayName,
              maxBytes: MAX_UPLOAD_BYTES,
            })
          : await store.saveBytes({
              data: source.data,
              mime,
              displayName,
              maxBytes: MAX_UPLOAD_BYTES,
            })
      if (res.ok) return { upload: res.value.ref }
      // Effect-boundary log: the webview gets a typed error entry; the log keeps the detail.
      log.error("upload save failed", {
        displayName,
        kind: res.error.kind,
        detail: res.error.detail,
      })
      return {
        error: {
          displayName,
          reason: res.error.kind === "too-large" ? "too-large" : "io-failed",
        },
      }
    }),
  )
  const uploads = perFile.flatMap((f) =>
    f.upload === undefined ? [] : [f.upload],
  )
  const rejected = perFile.flatMap((f) =>
    f.rejected === undefined ? [] : [f.rejected],
  )
  const errors = perFile.flatMap((f) =>
    f.error === undefined ? [] : [f.error],
  )
  log.debug("ingested uploads", {
    total: sources.length,
    saved: uploads.length,
    rejected: rejected.length,
    errors: errors.length,
  })
  return {
    uploads,
    ...(rejected.length > 0 ? { rejected } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  }
}
