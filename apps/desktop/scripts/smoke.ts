#!/usr/bin/env bun
// Cross-platform GUI smoke: launch the built app and prove the proxy answers /health on loopback.
// Exits non-zero on any failure.
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { defaultConfig } from "@spectrum/config"
import {
  type Platform,
  channelProxyPortOffset,
  detectPlatform,
} from "@spectrum/platform"

/**
 * The port the smoke polls for /health. The smoke always launches the DEV bundle (CI builds the dev
 * bundle for the verified-running smoke), whose proxy binds the dev channel's EFFECTIVE port —
 * mirroring composition: the default proxy port + the dev channel offset (stable 0 / canary 1 /
 * dev 2). Hardcoding the base port broke the canary build once channels gained per-channel ports.
 */
export const smokeHealthPort = (): number =>
  defaultConfig().settings.proxyPort + channelProxyPortOffset("development")

const PORT = Number(process.env.LK_PORT ?? String(smokeHealthPort()))
const BUILD_DIR = join(import.meta.dir, "..", "build")

/**
 * The Electrobun bundle's entry point is the `launcher` binary (`launcher.exe` on Windows) —
 * NOT a file named after the app. The bundle also ships other executables (`bun`, `bspatch`, …)
 * that must NOT be picked, so match the launcher by exact basename. App-named binaries
 * (`Spectrum` / `Spectrum.exe`) are accepted as a fallback for non-dev release layouts.
 */
export const launcherCandidates = (platform: Platform): readonly string[] =>
  platform === "windows"
    ? ["launcher.exe", "spectrum.exe", "spectrum-dev.exe"]
    : ["launcher", "spectrum", "spectrum-dev"]

export const isLauncherEntry = (entry: string, platform: Platform): boolean =>
  launcherCandidates(platform).includes(entry.toLowerCase())

/** Recursively find the Electrobun launcher executable under the platform's build subdir. */
export const resolveAppExecutable = (
  buildDir: string = BUILD_DIR,
  platform: Platform = detectPlatform(),
): string => {
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        const found = walk(full)
        if (found) return found
      } else if (isLauncherEntry(entry, platform)) {
        return full
      }
    }
    return null
  }
  if (!existsSync(buildDir)) {
    throw new Error(`build dir not found: ${buildDir} (run the build first)`)
  }
  const exe = walk(buildDir)
  if (!exe)
    throw new Error(`could not locate a Spectrum launcher under ${buildDir}`)
  return exe
}

/**
 * How the smoked app is torn down. The Electrobun launcher spawns the real app as its OWN
 * child (and CEF spawns helpers under that), so signalling just the launcher pid leaves the
 * tree alive holding the smoke's stdio — the CI step's log pipe never reaches EOF and the job
 * hangs to GitHub's 6h default timeout (v1.9.0 / the 2026-07-30 canary, on linux-arm64, where
 * the orphaned app entered a `stack smashing detected` respawn loop AFTER the smoke passed).
 * Teardown therefore targets the whole process GROUP, never the direct child alone.
 */
export type TeardownStep =
  | { readonly kind: "signal-group"; readonly signal: "SIGTERM" | "SIGKILL" }
  | { readonly kind: "taskkill-tree" }

/** Windows has no posix process groups — `taskkill /T` is its tree-kill equivalent. */
export const teardownPlan = (platform: Platform): readonly TeardownStep[] =>
  platform === "windows"
    ? [{ kind: "taskkill-tree" }]
    : [
        { kind: "signal-group", signal: "SIGTERM" },
        { kind: "signal-group", signal: "SIGKILL" },
      ]

export type TerminateDeps = {
  readonly platform: Platform
  /** Signal a process GROUP; `pid` is already negated (`-1234`) per posix convention. */
  readonly signalGroup: (pid: string, signal: string) => void
  readonly killTree: (pid: number) => void
}

/**
 * Reap the smoked app's entire process tree. Every step is best-effort: a group that already
 * exited raises ESRCH, which means "nothing survives" — the goal — so it must not fail the smoke.
 */
export const terminateAppTree = (pid: number, deps: TerminateDeps): void => {
  for (const step of teardownPlan(deps.platform)) {
    try {
      if (step.kind === "taskkill-tree") deps.killTree(pid)
      else deps.signalGroup(`-${pid}`, step.signal)
    } catch {
      // already dead (ESRCH) or unsignalable — either way nothing is left to reap
    }
  }
}

const pollHealth = async (): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await Bun.sleep(500)
  }
  return false
}

/** Forward the child's output to our own stdio WITHOUT ever awaiting completion. */
const forward = (
  stream: ReadableStream<Uint8Array> | undefined,
  sink: NodeJS.WriteStream,
): void => {
  if (!stream) return
  void (async (): Promise<void> => {
    try {
      for await (const chunk of stream) sink.write(chunk)
    } catch {
      // the app died mid-write; its exit is the signal we care about, not this stream
    }
  })()
}

const realTerminateDeps: TerminateDeps = {
  platform: detectPlatform(),
  signalGroup: (pid, signal) => process.kill(Number(pid), signal),
  killTree: (pid) => {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"])
  },
}

const main = async (): Promise<void> => {
  const exe = resolveAppExecutable()
  console.log(`==> launching ${exe}`)
  // `detached` makes the child a process-GROUP leader, so teardown can reap the launcher's
  // grandchildren (the real app + CEF helpers) in one signal. Piping rather than inheriting
  // means the CI step's stdout is held by THIS process alone: even if a grandchild survives,
  // the log pipe still reaches EOF when the smoke exits, so the step can never hang.
  const proc = Bun.spawn([exe], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  forward(proc.stdout, process.stdout)
  forward(proc.stderr, process.stderr)
  const ok = await pollHealth()
  if (ok) {
    console.log("PASS: app launched and proxy answered /health on loopback")
  } else {
    console.error(
      `FAIL: proxy never answered /health on 127.0.0.1:${PORT} after launch`,
    )
  }
  terminateAppTree(proc.pid, realTerminateDeps)
  // Exit explicitly: a wedged app (or a CEF crash-respawn loop) must never keep the smoke
  // alive waiting on a stray handle — the verdict is already decided above.
  process.exit(ok ? 0 : 1)
}

// Only launch when run directly (`bun scripts/smoke.ts`); importing for tests must not spawn.
if (import.meta.main) await main()
