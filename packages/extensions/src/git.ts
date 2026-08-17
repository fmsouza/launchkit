import { resolve as resolvePath } from "node:path"
import type { CommandResolver, ProcessSpawner } from "@spectrum/proc"
import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"
import { redactUrlCredentials } from "./redact"

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

/**
 * Overrides for the vars that turn env inheritance into command execution or a stuck
 * credential prompt. This is NOT a minimal env in the strict sense: the only real
 * `ProcessSpawner` (`createBunProcessSpawner`, shared with `@spectrum/harnesses` and
 * `@spectrum/provider-host`) merges the ambient process env
 * UNDERNEATH whatever is passed here (`{ ...process.env, ...env }`), so an ambient
 * `SECRET_TOKEN` or similar still reaches the child. What this map guarantees is narrower
 * but load-bearing: `GIT_ASKPASS`/`SSH_ASKPASS`/`GIT_PROXY_COMMAND` are forced empty so an
 * ambient askpass helper or proxy command can never run underneath us, and
 * `GIT_TERMINAL_PROMPT=0` makes a private repo fail fast instead of hanging on a prompt
 * nobody can answer.
 */
export const gitEnv = (): Readonly<Record<string, string>> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_PROXY_COMMAND: "",
})

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
    // `--` ends option parsing: without it, a `ref`/`url` value starting with `-` (e.g.
    // `--upload-pack=<cmd>`) is parsed by git as an OPTION, not a positional argument, and
    // can run an arbitrary command (`git clone --upload-pack=<cmd>`). An argument array
    // stops shell injection but not this — verified against real git that `--` still
    // clones/fetches normally and turns a malicious `--upload-pack=...` ref into a rejected
    // "invalid refspec" instead of an executed command.
    clone: (url, dest, ref) => {
      const args =
        ref === undefined
          ? ["clone", "--depth", "1", "--", url, dest]
          : ["clone", "--depth", "1", "--branch", ref, "--", url, dest]
      return run(args)
    },

    fetchCheckout: async (dir, ref) => {
      const fetched = await run(
        ["fetch", "--depth", "1", "--", "origin", ref],
        dir,
      )
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

/** True when `candidate` is `root` itself or a descendant of it. Both sides are resolved with
 * `path.resolve` (against `process.cwd()`) before comparing — a lexical prefix check on the
 * raw strings is defeated by a `from` containing `..` (e.g. `copy("/a/b/..", "/a/b")` is
 * really a self-copy but does not lexically match) or by a missing/differing trailing
 * separator. Copying a directory into itself or into its own descendant is destructive. */
const isSelfOrDescendant = (candidate: string, root: string): boolean => {
  const normCandidate = resolvePath(candidate)
  const normRoot = resolvePath(root)
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
