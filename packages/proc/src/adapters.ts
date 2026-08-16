import {
  type Platform,
  detectPlatform,
  isAbsolutePath,
} from "@spectrum/platform"
import { type Result, err, ok } from "@spectrum/utils"
import { type CommandResolver, guardCommand } from "./command-resolver"
import type { ProcError } from "./errors"
import type { ProcessSpawner, SpawnedProcess } from "./process-spawner"

/** Real resolver: guard the input, then resolve bare names via `Bun.which`. */
export const createPathCommandResolver = (
  platform: Platform = detectPlatform(),
): CommandResolver => ({
  resolve: (command: string): Result<string, ProcError> => {
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
  ): Result<SpawnedProcess, ProcError> => {
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
