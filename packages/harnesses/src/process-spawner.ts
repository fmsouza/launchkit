import { type Result, ok } from "@launchkit/utils"
import type { HarnessError } from "./errors"

/** Spawns a process from an absolute command + argument ARRAY + env map. Never a shell string. */
export interface ProcessSpawner {
  spawn(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Result<{ readonly pid: number }, HarnessError>
}

export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface RecordingProcessSpawner extends ProcessSpawner {
  readonly calls: readonly SpawnCall[]
}

/** Records every spawn call (for assertions) and returns the given pid. */
export const createRecordingProcessSpawner = (
  pid: number,
): RecordingProcessSpawner => {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawn: (
      command,
      args,
      env,
    ): Result<{ readonly pid: number }, HarnessError> => {
      calls.push({ command, args, env })
      return ok({ pid })
    },
  }
}
