import type { AttachmentRef } from "@spectrum/agent-events"
import type { Result } from "@spectrum/utils"

export type StoredUpload = {
  readonly ref: AttachmentRef
  /** Absolute on-disk path; main-process-internal — never crosses to the webview. */
  readonly path: string
}

export type UploadError = {
  readonly kind: "io-failed" | "not-found" | "too-large"
  readonly detail: string
}

export interface UploadStore {
  save(params: {
    sourcePath: string
    mime: string
    displayName: string
    maxBytes: number
  }): Promise<Result<StoredUpload, UploadError>>
  readBase64(id: string): Promise<Result<string, UploadError>>
  pathOf(id: string): Promise<Result<string, UploadError>>
  exists(id: string): Promise<boolean>
  size(): Promise<number>
}
