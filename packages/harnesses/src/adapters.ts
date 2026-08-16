import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { HarnessDefinitionSchema } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { HarnessError } from "./errors"
import type { HarnessFileSource } from "./file-source"

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Reject ids that are empty or could escape `dir` (path separators / parent refs). */
const safeId = (id: string): Result<string, HarnessError> => {
  if (id.length === 0 || id.includes("/") || id.includes("\\") || id === "..") {
    return err({ kind: "write-failed", detail: `unsafe harness id: ${id}` })
  }
  return ok(id)
}

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: string }).code === code

/** Real file source: read + JSON-parse every `*.json` in `dir`. Missing dir = empty list. */
export const createDirHarnessFileSource = (dir: string): HarnessFileSource => ({
  listDefinitions: async (): Promise<
    Result<readonly unknown[], HarnessError>
  > => {
    let entries: readonly string[]
    try {
      entries = await readdir(dir)
    } catch (cause) {
      // A missing directory is not an error — the user simply has no custom harnesses.
      if (isErrno(cause, "ENOENT")) {
        return ok([])
      }
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "read-failed", detail })
    }

    const defs: unknown[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      try {
        const text = await Bun.file(join(dir, entry)).text()
        defs.push(JSON.parse(text) as unknown)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        return err({ kind: "read-failed", detail: `${entry}: ${detail}` })
      }
    }
    return ok(defs)
  },

  writeDefinition: async (
    definition: unknown,
  ): Promise<Result<void, HarnessError>> => {
    const parsed = HarnessDefinitionSchema.safeParse(definition)
    if (!parsed.success) {
      return err({ kind: "invalid-definition", detail: parsed.error.message })
    }
    const id = safeId(parsed.data.id)
    if (!id.ok) return id

    const path = join(dir, `${id.value}.json`)
    const tmp = `${path}.tmp`
    const contents = `${JSON.stringify(parsed.data, null, 2)}\n`
    try {
      await mkdir(dir, { recursive: true, mode: DIR_MODE })
      await Bun.write(tmp, contents)
      await chmod(tmp, FILE_MODE)

      // fsync the temp file so the bytes are durable before the rename swaps it in.
      const handle = await open(tmp, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }

      await rename(tmp, path)
      await chmod(path, FILE_MODE)
      return ok(undefined)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "write-failed", detail })
    }
  },

  deleteDefinition: async (id: string): Promise<Result<void, HarnessError>> => {
    const safe = safeId(id)
    if (!safe.ok) return safe
    try {
      await unlink(join(dir, `${safe.value}.json`))
      return ok(undefined)
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return ok(undefined)
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "write-failed", detail })
    }
  },
})
