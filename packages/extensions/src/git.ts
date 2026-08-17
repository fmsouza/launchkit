import type { CommandResolver, ProcessSpawner } from "@spectrum/proc"
import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"

/** Reads a completed child's stdout as text. `ProcessSpawner` deliberately exposes no stdout —
 * this is the one seam that needs it (`revParse`), injected rather than widening the spawner
 * for a single caller. */
export type CaptureStdout = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<Result<string, PluginError>>

export type GitClient = {
  clone(
    url: string,
    dest: string,
    ref?: string,
  ): Promise<Result<void, PluginError>>
  fetchCheckout(dir: string, ref: string): Promise<Result<void, PluginError>>
  revParse(dir: string): Promise<Result<string, PluginError>>
}

export type GitCall = {
  readonly op: "clone" | "fetchCheckout" | "revParse"
  readonly args: readonly string[]
}

/** Strips an embedded `user:pass@` credential segment from a url before it ever reaches a log
 * line or an error detail (Global Constraint 10: never log a url without stripping it first). */
const redactUrlCredentials = (url: string): string =>
  url.replace(/\/\/[^/@\s]+@/, "//[REDACTED]@")

/** The minimal env git needs — never the whole process env. `GIT_TERMINAL_PROMPT=0` makes a
 * private repo fail fast instead of hanging on a password prompt nobody can answer; the
 * ambient `GIT_ASKPASS`/`SSH_ASKPASS`/`GIT_TERMINAL_PROMPT` are deliberately NOT forwarded so
 * an interactive prompt can never be triggered underneath us. */
export const gitEnv = (): Readonly<Record<string, string>> => {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  return env
}

/**
 * Resolves `git` through the injected `CommandResolver`, spawns with an argument array (never
 * a shell string), and awaits the child's exit code. A non-zero exit or a resolve failure is
 * `git-failed`, with the url/command redacted before it lands in the error detail.
 */
export const createProcessGitClient = (deps: {
  readonly resolver: CommandResolver
  readonly spawner: ProcessSpawner
  readonly capture: CaptureStdout
}): GitClient => {
  const run = async (
    args: readonly string[],
    cwd?: string,
  ): Promise<Result<void, PluginError>> => {
    const resolved = deps.resolver.resolve("git")
    if (!resolved.ok) {
      return err({
        kind: "git-failed",
        detail: `git is not available: ${resolved.error.detail}`,
      })
    }
    const spawned = deps.spawner.spawn(resolved.value, args, gitEnv(), cwd)
    if (!spawned.ok) {
      return err({
        kind: "git-failed",
        detail: `failed to spawn git: ${spawned.error.detail}`,
      })
    }
    const exitCode = await spawned.value.exited
    if (exitCode !== 0) {
      return err({
        kind: "git-failed",
        detail: `git ${args.map(redactUrlCredentials).join(" ")} exited with code ${exitCode}`,
      })
    }
    return ok(undefined)
  }

  return {
    clone: (url, dest, ref) => {
      const args =
        ref === undefined
          ? ["clone", "--depth", "1", url, dest]
          : ["clone", "--depth", "1", "--branch", ref, url, dest]
      return run(args)
    },

    fetchCheckout: async (dir, ref) => {
      const fetched = await run(["fetch", "--depth", "1", "origin", ref], dir)
      if (!fetched.ok) return fetched
      return run(["checkout", "FETCH_HEAD"], dir)
    },

    revParse: async (dir) => {
      const resolved = deps.resolver.resolve("git")
      if (!resolved.ok) {
        return err({
          kind: "git-failed",
          detail: `git is not available: ${resolved.error.detail}`,
        })
      }
      const captured = await deps.capture(
        resolved.value,
        ["rev-parse", "HEAD"],
        dir,
      )
      if (!captured.ok) return captured
      const trimmed = captured.value.trim()
      if (trimmed.length === 0) {
        return err({
          kind: "git-failed",
          detail: "git rev-parse produced no output",
        })
      }
      return ok(trimmed)
    },
  }
}

/** In-memory fake `GitClient`: records every call and either succeeds with a canned commit or
 * returns the supplied failure for every operation. */
export const createFakeGitClient = (opts?: {
  readonly commit?: string
  readonly failure?: PluginError
}): GitClient & { readonly calls: readonly GitCall[] } => {
  const calls: GitCall[] = []

  const record = (op: GitCall["op"], args: readonly string[]): void => {
    calls.push({ op, args })
  }

  return {
    calls,
    clone: async (url, dest, ref) => {
      record("clone", ref === undefined ? [url, dest] : [url, dest, ref])
      if (opts?.failure !== undefined) return err(opts.failure)
      return ok(undefined)
    },
    fetchCheckout: async (dir, ref) => {
      record("fetchCheckout", [dir, ref])
      if (opts?.failure !== undefined) return err(opts.failure)
      return ok(undefined)
    },
    revParse: async (dir) => {
      record("revParse", [dir])
      if (opts?.failure !== undefined) return err(opts.failure)
      return ok(opts?.commit ?? "abc123")
    },
  }
}

export type DirCopier = {
  copy(from: string, to: string): Promise<Result<void, PluginError>>
  exists(dir: string): Promise<boolean>
}

/** Normalises trailing separators so containment comparisons aren't fooled by them. */
const stripTrailingSep = (p: string): string =>
  p.endsWith("/") ? p.slice(0, -1) : p

/** True when `candidate` is `root` itself or a descendant of it. Compares normalised absolute
 * paths — copying a directory into itself or into its own descendant would be destructive. */
const isSelfOrDescendant = (candidate: string, root: string): boolean => {
  const normCandidate = stripTrailingSep(candidate)
  const normRoot = stripTrailingSep(root)
  return normCandidate === normRoot || normCandidate.startsWith(`${normRoot}/`)
}

/** Real copier: recursive `fs.cp` behind the `DirCopier` seam. */
export const createFsDirCopier = (): DirCopier => ({
  copy: async (from, to) => {
    if (isSelfOrDescendant(to, from)) {
      return err({
        kind: "read-failed",
        detail: `cannot copy a directory into itself or a descendant: ${from} -> ${to}`,
      })
    }
    try {
      const { cp } = await import("node:fs/promises")
      await cp(from, to, { recursive: true })
      return ok(undefined)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "read-failed", detail })
    }
  },
  exists: async (dir) => {
    try {
      const { stat } = await import("node:fs/promises")
      await stat(dir)
      return true
    } catch {
      return false
    }
  },
})

/** In-memory fake `DirCopier`: `present` seeds which source directories exist; `copy` records
 * what it copied and marks the destination present, so a test can assert nothing hit disk. */
export const createInMemoryDirCopier = (
  present?: readonly string[],
): DirCopier & {
  readonly copies: readonly { from: string; to: string }[]
  add(dir: string): void
  drop(dir: string): void
} => {
  const dirs = new Set<string>(present ?? [])
  const copies: { from: string; to: string }[] = []

  return {
    copies,
    add: (dir) => {
      dirs.add(dir)
    },
    drop: (dir) => {
      dirs.delete(dir)
    },
    copy: async (from, to) => {
      if (!dirs.has(from)) {
        return err({
          kind: "read-failed",
          detail: `source directory does not exist: ${from}`,
        })
      }
      copies.push({ from, to })
      dirs.add(to)
      return ok(undefined)
    },
    exists: async (dir) => dirs.has(dir),
  }
}
