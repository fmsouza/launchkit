import { type Result, ok } from "@spectrum/utils"
import type { ProcError } from "./errors"

/** A spawned child's identity + a promise that resolves with its exit code. */
export interface SpawnedProcess {
  readonly pid: number
  /** Resolves with the child's exit code once it exits (mirrors Bun's `child.exited`). */
  readonly exited: Promise<number>
}

/** Spawns a process from an absolute command + argument ARRAY + env map. Never a shell string. */
export interface ProcessSpawner {
  spawn(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd?: string,
  ): Result<SpawnedProcess, ProcError>
}

export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface RecordingProcessSpawner extends ProcessSpawner {
  readonly calls: readonly SpawnCall[]
}

/**
 * Records every spawn call (for assertions) and returns the given pid. `exited` resolves
 * immediately with `exitCode` (default 0) so tests can drive the foreground-launch lifecycle.
 */
export const createRecordingProcessSpawner = (
  pid: number,
  exitCode = 0,
): RecordingProcessSpawner => {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawn: (command, args, env, cwd): Result<SpawnedProcess, ProcError> => {
      calls.push({ command, args, env, ...(cwd !== undefined ? { cwd } : {}) })
      return ok({ pid, exited: Promise.resolve(exitCode) })
    },
  }
}
