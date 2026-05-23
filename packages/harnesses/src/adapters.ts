import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { type Result, ok, err } from "@launchkit/utils"
import type { HarnessError } from "./errors"
import { type CommandResolver, guardCommand } from "./command-resolver"
import type { ProcessSpawner } from "./process-spawner"
import type { HarnessFileSource } from "./file-source"

/** Real resolver: guard the input, then resolve bare names via `Bun.which`. */
export const createPathCommandResolver = (): CommandResolver => ({
  resolve: (command: string): Result<string, HarnessError> => {
    const guarded = guardCommand(command)
    if (!guarded.ok) return guarded
    if (command.startsWith("/")) return ok(command)
    const found = Bun.which(command)
    if (found === null) {
      return err({ kind: "invalid-command", detail: `command not found on PATH: ${command}` })
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
  ): Result<{ readonly pid: number }, HarnessError> => {
    try {
      const child = Bun.spawn([command, ...args], { env, stdio: ["inherit", "inherit", "inherit"] })
      return ok({ pid: child.pid })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "spawn-failed", detail })
    }
  },
})

/** Real file source: read + JSON-parse every `*.json` in `dir`. Missing dir = empty list. */
export const createDirHarnessFileSource = (dir: string): HarnessFileSource => ({
  listDefinitions: async (): Promise<Result<readonly unknown[], HarnessError>> => {
    let entries: readonly string[]
    try {
      entries = await readdir(dir)
    } catch (cause) {
      // A missing directory is not an error — the user simply has no custom harnesses.
      if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT") {
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
})
