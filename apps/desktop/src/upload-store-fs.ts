import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AttachmentRef } from "@spectrum/agent-events"
import { inferKind } from "@spectrum/agent-events"
import type {
  StoredUpload,
  UploadError,
  UploadStore,
} from "@spectrum/runtime-core"
import type { Result } from "@spectrum/utils"

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

  const ensureDir = async (): Promise<void> => {
    await mkdir(uploadsDir, { recursive: true })
  }

  const findPathForId = async (id: string): Promise<string | null> => {
    try {
      const entries = await readdir(uploadsDir)
      const match = entries.find((e) => e.startsWith(`${id}.`))
      return match === undefined ? null : join(uploadsDir, match)
    } catch {
      return null
    }
  }

  const persist = async (
    data: Uint8Array,
    mime: string,
    displayName: string,
    maxBytes: number,
  ): Promise<Result<StoredUpload, UploadError>> => {
    try {
      await ensureDir()
      if (data.byteLength > maxBytes) {
        return {
          ok: false,
          error: err("too-large", `${data.byteLength} > ${maxBytes}`),
        }
      }
      const id = createHash("sha256").update(data).digest("hex")
      const ext = extOf(displayName)
      const dest = join(uploadsDir, `${id}${ext}`)
      const ref: AttachmentRef = {
        id,
        mime,
        displayName,
        kind: inferKind(mime, displayName),
        bytes: data.byteLength,
      }
      // Idempotent: if dest exists with the same size, skip the write.
      try {
        const existing = await stat(dest)
        if (existing.size === data.byteLength) {
          return { ok: true, value: { ref, path: dest } }
        }
      } catch {
        // dest doesn't exist — proceed to write
      }
      await writeFile(dest, data)
      return { ok: true, value: { ref, path: dest } }
    } catch (e) {
      return {
        ok: false,
        error: err("io-failed", e instanceof Error ? e.message : String(e)),
      }
    }
  }

  return {
    async save({
      sourcePath,
      mime,
      displayName,
      maxBytes,
    }: {
      sourcePath: string
      mime: string
      displayName: string
      maxBytes: number
    }) {
      try {
        const st = await stat(sourcePath)
        if (st.size > maxBytes) {
          return {
            ok: false as const,
            error: err("too-large", `${st.size} > ${maxBytes}`),
          }
        }
        const data = await readFile(sourcePath)
        return persist(data, mime, displayName, maxBytes)
      } catch (e) {
        return {
          ok: false as const,
          error: err("io-failed", e instanceof Error ? e.message : String(e)),
        }
      }
    },

    async saveBytes({
      data,
      mime,
      displayName,
      maxBytes,
    }: {
      data: Uint8Array
      mime: string
      displayName: string
      maxBytes: number
    }) {
      return persist(data, mime, displayName, maxBytes)
    },

    async readBase64(id: string) {
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

    async pathOf(id: string) {
      const path = await findPathForId(id)
      if (path === null) return { ok: false, error: err("not-found", id) }
      return { ok: true, value: path }
    },

    async exists(id: string) {
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
