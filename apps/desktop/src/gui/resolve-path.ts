import { homedir } from "node:os"
import {
  type Platform,
  commonBinDirs,
  detectPlatform,
  loginShellPathProbe,
  mergePathEntries,
  parseLoginShellPath,
  pathDelimiter,
} from "@spectrum/platform"

/**
 * Synchronously run a shell command and return its stdout, or null on any failure.
 * The single spawn effect behind `resolveGuiPath`'s `probeShellPath` seam.
 */
export type ShellPathProbe = (
  command: string,
  args: readonly string[],
) => string | null

export interface ResolveGuiPathDeps {
  readonly platform: Platform
  readonly homeDir: string
  /** The inherited PATH (`process.env.PATH`) — minimal when launched from Finder/Dock. */
  readonly basePath: string | undefined
  /** The user's login shell (`process.env.SHELL`); when absent, only the static dirs are used. */
  readonly shell: string | undefined
  readonly probeShellPath: ShellPathProbe
}

/**
 * Compute the PATH a GUI-launched process should search: the user's real login-shell
 * PATH (so version-manager shims like nvm/asdf are found) prepended to the inherited
 * minimal PATH, with the well-known install dirs as a static fallback. Pure given the
 * injected `probeShellPath`. See `@spectrum/platform`'s path-env helpers.
 */
export const resolveGuiPath = (deps: ResolveGuiPathDeps): string => {
  const shellEntries = ((): readonly string[] => {
    if (deps.shell === undefined || deps.shell === "") return []
    const probe = loginShellPathProbe(deps.shell)
    const stdout = deps.probeShellPath(probe.command, probe.args)
    if (stdout === null) return []
    const parsed = parseLoginShellPath(stdout)
    if (parsed === null) return []
    return parsed.split(pathDelimiter(deps.platform)).filter((e) => e !== "")
  })()
  const additions = [
    ...shellEntries,
    ...commonBinDirs({ platform: deps.platform, homeDir: deps.homeDir }),
  ]
  return mergePathEntries(deps.basePath, additions, deps.platform)
}

/** Async variant of {@link ShellPathProbe}: resolves to stdout text or null. The async enricher
 * wraps every call in try/catch so a rejected probe never propagates as a rejection. */
export type ShellPathProbeAsync = (
  command: string,
  args: readonly string[],
) => Promise<string | null>

/** Real async probe: `Bun.spawn` (NOT `spawnSync`) so the Worker's JS thread is never blocked
 * during the packaged-GUI startup / first-IPC window. The synchronous spawn was the single
 * heavyweight native effect on the Worker's hot path right before the nondeterministic
 * `EXC_BREAKPOINT`/`brk 1` crash on the Worker thread (survives #94/#98/#99). */
const realProbeShellPathAsync: ShellPathProbeAsync = async (command, args) => {
  try {
    const r = await Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await r.exited
    if (exitCode !== 0) return null
    const text = await new Response(r.stdout).text()
    return text
  } catch {
    return null
  }
}

let pending: Promise<string> | undefined

/** Test-only reset of the memoized in-flight/settled promise. Production never calls this. */
export const __resetGuiPathAsyncForTest = (): void => {
  pending = undefined
}

/**
 * Resolve the GUI PATH off the Worker's hot startup path. Runs the login-shell probe via an
 * ASYNC `Bun.spawn` (never `spawnSync`), memoized so the shell is forked at most once per
 * process. Mutates `process.env.PATH` once when the probe settles. The sole consumer
 * (`@spectrum/harnesses`' `createPathCommandResolver`) reads `process.env.PATH` LIVE at
 * harness-launch time via `Bun.which(command, { PATH: process.env.PATH })`, so the enrichment
 * only needs to settle before the first harness launch — not before the window opens. Never
 * rejects; a failed/throwing probe falls back to the static common bin dirs (same behavior as
 * the synchronous `enrichGuiPath`).
 */
export const enrichGuiPathAsync = (
  probeShellPath: ShellPathProbeAsync = realProbeShellPathAsync,
): Promise<string> => {
  if (pending) return pending
  pending = (async () => {
    const shell = process.env.SHELL
    // Await the probe BEFORE invoking the pure resolver, then hand the result in via a sync seam.
    let probed: string | null = null
    if (shell !== undefined && shell !== "") {
      const p = loginShellPathProbe(shell)
      try {
        probed = await probeShellPath(p.command, p.args)
      } catch {
        probed = null
      }
    }
    const next = resolveGuiPath({
      platform: detectPlatform(),
      homeDir: homedir(),
      basePath: process.env.PATH,
      shell,
      // Sync seam returning the already-awaited result; resolveGuiPath handles parse + fallback.
      probeShellPath: () => probed,
    })
    process.env.PATH = next
    return next
  })()
  return pending
}
