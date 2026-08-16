import {
  type Platform,
  detectPlatform,
  isAbsolutePath,
} from "@spectrum/platform"
import { type Result, err, ok } from "@spectrum/utils"
import type { ProcError } from "./errors"

/** Resolves a command name/path to a validated absolute path, or rejects it. */
export interface CommandResolver {
  resolve(command: string): Result<string, ProcError>
}

const hasSeparator = (p: string): boolean => p.includes("/") || p.includes("\\")

const isRelativePath = (p: string, platform: Platform): boolean =>
  p.startsWith("./") ||
  p.startsWith("../") ||
  p.startsWith(".\\") ||
  p.startsWith("..\\") ||
  (hasSeparator(p) && !isAbsolutePath(p, platform))

/**
 * Shared guard used by both the fake and the real resolver: reject relative paths and any path
 * containing `..`. Returns the input when it passes. `platform` defaults to the host.
 */
export const guardCommand = (
  command: string,
  platform: Platform = detectPlatform(),
): Result<string, ProcError> => {
  if (isRelativePath(command, platform)) {
    return err({
      kind: "invalid-command",
      detail: `relative paths are not allowed: ${command}`,
    })
  }
  if (command.split(/[/\\]/).includes("..")) {
    return err({
      kind: "invalid-command",
      detail: `path traversal is not allowed: ${command}`,
    })
  }
  return ok(command)
}

/**
 * In-memory fake. `pathTable` maps a bare command name to its absolute path. Absolute inputs pass
 * through after the guard; bare names must be in the table. `platform` defaults to the host.
 */
export const createFakeCommandResolver = (
  pathTable: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): CommandResolver => ({
  resolve: (command: string): Result<string, ProcError> => {
    const guarded = guardCommand(command, platform)
    if (!guarded.ok) return guarded
    if (isAbsolutePath(command, platform)) return ok(command)
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
