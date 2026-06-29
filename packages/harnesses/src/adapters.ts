import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  type Platform,
  detectPlatform,
  isAbsolutePath,
} from "@spectrum/platform"
import { HarnessDefinitionSchema } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import { type CommandResolver, guardCommand } from "./command-resolver"
import type { HarnessError } from "./errors"
import type { HarnessFileSource } from "./file-source"
import type { ProcessSpawner, SpawnedProcess } from "./process-spawner"

/** Real resolver: guard the input, then resolve bare names via `Bun.which`. */
export const createPathCommandResolver = (
  platform: Platform = detectPlatform(),
): CommandResolver => ({
  resolve: (command: string): Result<string, HarnessError> => {
    const guarded = guardCommand(command, platform)
    if (!guarded.ok) return guarded
    if (isAbsolutePath(command, platform)) return ok(command)
    // Pass the LIVE process.env.PATH explicitly: Bun.which() resolves against a
    // snapshot of PATH taken at process startup and ignores runtime mutations.
    // In a packaged Finder/Dock-launched app the startup PATH is minimal
    // (/usr/bin:/bin:/usr/sbin:/sbin), so enrichGuiPathAsync()'s runtime enrichment
    // (async + memoized; the async replacement for the prior sync probe) would
    // otherwise be invisible to Bun.which and harness commands never resolve.
    // Using ?? "" (not a fallback to the startup snapshot) is intentional: if PATH
    // is somehow unset, searching nothing is correct — never silently fall back to
    // the stale minimal snapshot we're trying to escape.
    const found = Bun.which(command, { PATH: process.env.PATH ?? "" })
    if (found === null) {
      return err({
        kind: "invalid-command",
        detail: `command not found on PATH: ${command}`,
      })
    }
    return ok(found)
  },
})

/** Real spawner: `Bun.spawn` with an ARGUMENT ARRAY — never a shell string. */
export const createBunProcessSpawner = (): ProcessSpawner => ({
  spawn: (
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd?: string,
  ): Result<SpawnedProcess, HarnessError> => {
    try {
      // MERGE the inherited environment with the rendered overrides: the child needs PATH/HOME/
      // TERM/etc. to function, while the rendered vars (proxy base-url + per-run key) WIN over any
      // pre-existing ones in the user's shell so the proxy stays authoritative.
      const child = Bun.spawn([command, ...args], {
        ...(cwd !== undefined ? { cwd } : {}),
        env: { ...process.env, ...env },
        stdio: ["inherit", "inherit", "inherit"],
      })
      return ok({ pid: child.pid, exited: child.exited })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "spawn-failed", detail })
    }
  },
})

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
