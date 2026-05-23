import { type Result, err, ok } from "@launchkit/utils"
import type { HarnessError } from "./errors"

/** Resolves a command name/path to a validated absolute path, or rejects it. */
export interface CommandResolver {
  resolve(command: string): Result<string, HarnessError>
}

const isAbsolute = (p: string): boolean => p.startsWith("/")
const isRelativePath = (p: string): boolean =>
  p.startsWith("./") ||
  p.startsWith("../") ||
  (p.includes("/") && !isAbsolute(p))

/**
 * Shared guard used by both the fake and the real resolver: reject relative
 * paths and any path containing `..`. Returns the input when it passes.
 */
export const guardCommand = (command: string): Result<string, HarnessError> => {
  if (isRelativePath(command)) {
    return err({
      kind: "invalid-command",
      detail: `relative paths are not allowed: ${command}`,
    })
  }
  if (command.split("/").includes("..")) {
    return err({
      kind: "invalid-command",
      detail: `path traversal is not allowed: ${command}`,
    })
  }
  return ok(command)
}

/**
 * In-memory fake. `pathTable` maps a bare command name to its absolute path.
 * Absolute inputs pass through after the guard; bare names must be in the table.
 */
export const createFakeCommandResolver = (
  pathTable: Readonly<Record<string, string>>,
): CommandResolver => ({
  resolve: (command: string): Result<string, HarnessError> => {
    const guarded = guardCommand(command)
    if (!guarded.ok) return guarded
    if (isAbsolute(command)) return ok(command)
    const found = pathTable[command]
    if (found === undefined) {
      return err({
        kind: "invalid-command",
        detail: `command not found on PATH: ${command}`,
      })
    }
    return ok(found)
  },
})
