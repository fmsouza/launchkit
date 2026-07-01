import { z } from "zod"

export type AttachmentKind = "image" | "pdf" | "text" | "binary"

export const AttachmentKindSchema = z.enum(["image", "pdf", "text", "binary"])

export const AttachmentRefSchema = z
  .object({
    /** Content-hash (sha256 hex) — stable across reloads; the uploads filename stem. */
    id: z.string().min(1),
    mime: z.string().min(1),
    displayName: z.string().min(1),
    kind: AttachmentKindSchema,
    bytes: z.number().int().nonnegative(),
  })
  .strict()
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

/** Present ONLY on the send path; never in the persisted text-delta event. */
export const AttachmentRefWithBytesSchema = AttachmentRefSchema.extend({
  dataUrl: z.string().min(1),
}).strict()
export type AttachmentRefWithBytes = z.infer<
  typeof AttachmentRefWithBytesSchema
>

export const AttachmentCapabilitiesSchema = z
  .object({
    image: z.boolean(),
    pdf: z.boolean(),
    binary: z.boolean(),
  })
  .strict()
export type AttachmentCapabilities = z.infer<
  typeof AttachmentCapabilitiesSchema
>

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".tsv",
  ".log",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".xml",
  ".env",
  ".gitignore",
  ".lock",
])

const lowerExt = (displayName: string): string => {
  const dot = displayName.lastIndexOf(".")
  return dot === -1 ? "" : displayName.slice(dot).toLowerCase()
}

/**
 * Single per-file size cap for staged uploads. Shared by the bun-side store
 * enforcement (picker + drag-and-drop ingest) and the webview-side pre-check
 * (skip reading/shipping oversized dropped files). One constant, one rule.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Infer the attachment kind from mime + filename. Pure. */
export const inferKind = (
  mime: string,
  displayName: string,
): AttachmentKind => {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("text/")) return "text"
  if (TEXT_EXTENSIONS.has(lowerExt(displayName))) return "text"
  return "binary"
}

/** Build the native-picker accepted-MIME list from capabilities. Pure. */
export const acceptedMimesFromCapabilities = (
  caps: AttachmentCapabilities,
): string[] => {
  const mimes: string[] = []
  if (caps.image)
    mimes.push("image/png", "image/jpeg", "image/gif", "image/webp")
  if (caps.pdf) mimes.push("application/pdf")
  if (caps.binary) mimes.push("*/*")
  return mimes
}

/** Strip the send-only `dataUrl` so the persisted event carries refs only. Pure. */
export const stripDataUrl = (ref: AttachmentRefWithBytes): AttachmentRef => {
  const { dataUrl: _dataUrl, ...rest } = ref
  return rest
}
