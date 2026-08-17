import { type Result, ok } from "@spectrum/utils"
import type { ProcError } from "./errors"

/** A spawned child's identity + a promise that resolves with its exit code. */
export interface SpawnedProcess {
  readonly pid: number
  /** Resolves with the child's exit code once it exits (mirrors Bun's `child.exited`). */
  readonly exited: Promise<number>
  /**
   * Signals the child to terminate (`defaultTerminationSignal()` for the host platform).
   * Idempotent from the caller's side: killing an already-exited child is a no-op.
   *
   * Kills the CHILD ONLY, not its process group — a group kill would require spawning
   * `detached`, which changes spawn semantics for every existing consumer. A child that
   * forks its own grandchildren may therefore leak them; that is an accepted limitation.
   */
  kill(): void
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
  /** Pids killed through `SpawnedProcess.kill()`, in call order. */
  readonly kills: readonly number[]
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
  const kills: number[] = []
  return {
    calls,
    kills,
    spawn: (command, args, env, cwd): Result<SpawnedProcess, ProcError> => {
      calls.push({ command, args, env, ...(cwd !== undefined ? { cwd } : {}) })
      return ok({
        pid,
        exited: Promise.resolve(exitCode),
        kill: (): void => {
          kills.push(pid)
        },
      })
    },
  }
}
