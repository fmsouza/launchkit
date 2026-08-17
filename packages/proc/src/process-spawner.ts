import { type Result, err, ok } from "@spectrum/utils"
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
 * Records every spawn call (for assertions) and hands out `pid`, `pid + 1`, … one per spawn.
 * `exited` resolves IMMEDIATELY with `exitCode` (default 0).
 *
 * That instant exit models a FOREGROUND, one-shot launch. It is the wrong fake for anything
 * that supervises a long-lived child: a supervisor reads the immediate resolution as an
 * instant crash and restarts in a storm. Use `createControllableProcessSpawner` there.
 */
export const createRecordingProcessSpawner = (
  pid: number,
  exitCode = 0,
): RecordingProcessSpawner => {
  const calls: SpawnCall[] = []
  const kills: number[] = []
  let nextPid = pid
  return {
    calls,
    kills,
    spawn: (command, args, env, cwd): Result<SpawnedProcess, ProcError> => {
      calls.push({ command, args, env, ...(cwd !== undefined ? { cwd } : {}) })
      const spawnedPid = nextPid++
      return ok({
        pid: spawnedPid,
        exited: Promise.resolve(exitCode),
        kill: (): void => {
          kills.push(spawnedPid)
        },
      })
    },
  }
}

/** A spawned child under test control: it exits only when the test says so. */
export interface ControllableChild {
  readonly pid: number
  /** Resolves the child's `exited` promise with this code. */
  exit(code: number): void
}

export interface ControllableProcessSpawner extends ProcessSpawner {
  readonly calls: readonly SpawnCall[]
  /** Pids killed through `SpawnedProcess.kill()`, in call order. */
  readonly kills: readonly number[]
  readonly children: readonly ControllableChild[]
}

/**
 * The fake for LONG-LIVED children: each spawn gets its own pid and an `exited` promise that
 * stays pending until the test calls `children[i].exit(code)`. `kill()` records the pid and
 * exits the child with 143, exactly as a SIGTERM'd process does — which is what makes
 * stop-vs-restart ordering in a supervisor observable rather than a matter of argument.
 */
export const createControllableProcessSpawner = (options?: {
  readonly firstPid?: number
  readonly failure?: ProcError
}): ControllableProcessSpawner => {
  const calls: SpawnCall[] = []
  const kills: number[] = []
  const children: ControllableChild[] = []
  let nextPid = options?.firstPid ?? 100
  return {
    calls,
    kills,
    children,
    spawn: (command, args, env, cwd): Result<SpawnedProcess, ProcError> => {
      const failure = options?.failure
      if (failure !== undefined) return err(failure)
      calls.push({ command, args, env, ...(cwd !== undefined ? { cwd } : {}) })
      const pid = nextPid++
      let settle: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        settle = resolve
      })
      children.push({
        pid,
        exit: (code: number): void => settle(code),
      })
      return ok({
        pid,
        exited,
        kill: (): void => {
          kills.push(pid)
          settle(143)
        },
      })
    },
  }
}
