import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isLauncherEntry,
  resolveAppExecutable,
  smokeHealthPort,
  teardownPlan,
  terminateAppTree,
} from "./smoke"

describe("smokeHealthPort", () => {
  it("polls the dev bundle's channel-offset proxy port, not the base port", () => {
    // The smoke launches the DEV bundle, whose proxy binds the dev channel's effective port:
    // the base proxy port (4000) + the dev channel offset (2) = 4002. Polling the base 4000
    // (the old hardcoded default) never gets a /health response, which broke the canary build.
    expect(smokeHealthPort()).toBe(4002)
    expect(smokeHealthPort()).not.toBe(4000)
  })
})

describe("isLauncherEntry", () => {
  it("matches the Electrobun launcher on posix platforms", () => {
    expect(isLauncherEntry("launcher", "macos")).toBe(true)
    expect(isLauncherEntry("launcher", "linux")).toBe(true)
  })

  it("matches launcher.exe on windows (and rejects the bare name)", () => {
    expect(isLauncherEntry("launcher.exe", "windows")).toBe(true)
    expect(isLauncherEntry("launcher", "windows")).toBe(false)
  })

  it("accepts an app-named release binary as a fallback", () => {
    expect(isLauncherEntry("Spectrum", "macos")).toBe(true)
    expect(isLauncherEntry("Spectrum.exe", "windows")).toBe(true)
  })

  it("does NOT match the other executables bundled beside the launcher", () => {
    expect(isLauncherEntry("bun", "macos")).toBe(false)
    expect(isLauncherEntry("bspatch", "linux")).toBe(false)
    expect(isLauncherEntry("zig-zstd", "macos")).toBe(false)
  })
})

describe("resolveAppExecutable", () => {
  it("finds the launcher nested inside a macOS .app bundle, ignoring the bundled bun", () => {
    const root = mkdtempSync(join(tmpdir(), "lk-smoke-"))
    const macos = join(
      root,
      "dev-macos-arm64",
      "Spectrum-dev.app",
      "Contents",
      "MacOS",
    )
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, "bun"), "") // decoy executable that must be skipped
    writeFileSync(join(macos, "launcher"), "") // the real entry point
    expect(resolveAppExecutable(root, "macos")).toBe(join(macos, "launcher"))
  })

  it("finds launcher.exe in a Windows build layout", () => {
    const root = mkdtempSync(join(tmpdir(), "lk-smoke-win-"))
    const dir = join(root, "dev-win-x64", "Spectrum-dev")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "bun.exe"), "")
    writeFileSync(join(dir, "launcher.exe"), "")
    expect(resolveAppExecutable(root, "windows")).toBe(
      join(dir, "launcher.exe"),
    )
  })

  it("throws a clear error when no launcher exists", () => {
    const root = mkdtempSync(join(tmpdir(), "lk-smoke-empty-"))
    mkdirSync(join(root, "dev-macos-arm64"), { recursive: true })
    expect(() => resolveAppExecutable(root, "macos")).toThrow(
      /could not locate/,
    )
  })

  it("throws when the build dir is missing entirely", () => {
    expect(() =>
      resolveAppExecutable(
        join(tmpdir(), "lk-nonexistent-build-dir-xyz"),
        "macos",
      ),
    ).toThrow(/build dir not found/)
  })
})

describe("teardownPlan", () => {
  // The Electrobun launcher spawns the real app as its OWN child, so signalling only the
  // launcher pid leaves the app (and its CEF helpers) alive holding the inherited stdout —
  // the runner's log pipe never reaches EOF and the job hangs to the 6h default timeout.
  // Teardown must therefore target the whole process GROUP, not the direct child.
  it("signals the whole process group on posix, escalating TERM to KILL", () => {
    expect(teardownPlan("linux")).toEqual([
      { kind: "signal-group", signal: "SIGTERM" },
      { kind: "signal-group", signal: "SIGKILL" },
    ])
    expect(teardownPlan("macos")).toEqual(teardownPlan("linux"))
  })

  it("kills the process tree via taskkill on windows (no posix process groups)", () => {
    expect(teardownPlan("windows")).toEqual([{ kind: "taskkill-tree" }])
  })
})

describe("terminateAppTree", () => {
  it("escalates to SIGKILL on the group when SIGTERM leaves the tree alive", () => {
    const signalled: ReadonlyArray<string>[] = []
    terminateAppTree(4242, {
      platform: "linux",
      signalGroup: (pid, signal) => {
        signalled.push([String(pid), signal])
      },
      killTree: () => {
        throw new Error("taskkill must not be used on linux")
      },
    })
    // Negative pid = "the whole process group led by 4242", which is what actually
    // reaps the launcher's grandchildren.
    expect(signalled).toEqual([
      ["-4242", "SIGTERM"],
      ["-4242", "SIGKILL"],
    ])
  })

  it("uses taskkill on windows instead of group signals", () => {
    let treeKilled: number | null = null
    terminateAppTree(777, {
      platform: "windows",
      signalGroup: () => {
        throw new Error("posix group signals must not be used on windows")
      },
      killTree: (pid) => {
        treeKilled = pid
      },
    })
    expect(treeKilled).toBe(777)
  })

  it("keeps going when the group is already gone (ESRCH is success, not failure)", () => {
    // A tree that died on its own must not fail the smoke — the goal is "nothing survives",
    // and an already-dead group satisfies it.
    expect(() =>
      terminateAppTree(1, {
        platform: "linux",
        signalGroup: () => {
          throw new Error("ESRCH: no such process")
        },
        killTree: () => {},
      }),
    ).not.toThrow()
  })
})
