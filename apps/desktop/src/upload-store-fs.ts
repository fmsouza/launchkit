import { createHash } from "node:crypto"
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises"
import { join } from "node:path"
import type { AttachmentRef } from "@spectrum/agent-events"
import { inferKind } from "@spectrum/agent-events"
import type { Result } from "@spectrum/utils"
import type {
  StoredUpload,
  UploadError,
  UploadStore,
} from "./upload-store"

const err = (kind: UploadError["kind"], detail: string): UploadError => ({
  kind,
  detail,
})

const extOf = (displayName: string): string => {
  const dot = displayName.lastIndexOf(".")
  return dot === -1 ? "" : displayName.slice(dot)
}

export type FsUploadStoreDeps = {
  readonly uploadsDir: string
}

export const createFsUploadStore = (deps: FsUploadStoreDeps): UploadStore => {
  const { uploadsDir } = deps

  const ensureDir = (): Promise<void> => mkdir(uploadsDir, { recursive: true })

  const findPathForId = async (id: string): Promise<string | null> => {
    try {
      const entries = await readdir(uploadsDir)
      const match = entries.find((e) => e.startsWith(`${id}.`))
      return match === undefined ? null : join(uploadsDir, match)
    } catch {
      return null
    }
  }

  return {
    async save({ sourcePath, mime, displayName, maxBytes }) {
      try {
        await ensureDir()
        const st = await stat(sourcePath)
        if (st.size > maxBytes) {
          return { ok: false, error: err("too-large", `${st.size} > ${maxBytes}`) }
        }
        const data = await readFile(sourcePath)
        const id = createHash("sha256").update(data).digest("hex")
        const ext = extOf(displayName)
        const dest = join(uploadsDir, `${id}${ext}`)
        // Idempotent: if dest exists with the same size, skip the copy.
        try {
          const existing = await stat(dest)
          if (existing.size === st.size) {
            const ref: AttachmentRef = {
              id,
              mime,
              displayName,
              kind: inferKind(mime, displayName),
              bytes: st.size,
            }
            return { ok: true, value: { ref, path: dest } }
          }
        } catch {
          // dest doesn't exist — proceed to copy
        }
        await copyFile(sourcePath, dest)
        const ref: AttachmentRef = {
          id,
          mime,
          displayName,
          kind: inferKind(mime, displayName),
          bytes: st.size,
        }
        return { ok: true, value: { ref, path: dest } }
      } catch (e) {
        return {
          ok: false,
          error: err("io-failed", e instanceof Error ? e.message : String(e)),
        }
      }
    },

    async readBase64(id) {
      const path = await findPathForId(id)
      if (path === null) return { ok: false, error: err("not-found", id) }
      try {
        const buf = await readFile(path)
        return { ok: true, value: buf.toString("base64") }
      } catch (e) {
        return {
          ok: false,
          error: err("io-failed", e instanceof Error ? e.message : String(e)),
        }
      }
    },

    async pathOf(id) {
      const path = await findPathForId(id)
      if (path === null) return { ok: false, error: err("not-found", id) }
      return { ok: true, value: path }
    },

    async exists(id) {
      return (await findPathForId(id)) !== null
    },

    async size() {
      try {
        const entries = await readdir(uploadsDir)
        let total = 0
        for (const e of entries) {
          try {
            total += (await stat(join(uploadsDir, e))).size
          } catch {
            // skip
          }
        }
        return total
      } catch {
        return 0
      }
    },
  }
}
