import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { PATH_SENTINEL_END, PATH_SENTINEL_START } from "@spectrum/platform"
import {
  type ShellPathProbeAsync,
  __resetGuiPathAsyncForTest,
  enrichGuiPathAsync,
  resolveGuiPath,
} from "./resolve-path"

const wrap = (path: string): string =>
  `banner line\n${PATH_SENTINEL_START}${path}${PATH_SENTINEL_END}\n`

describe("resolveGuiPath", () => {
  it("prepends the login-shell PATH ahead of the inherited base", () => {
    const result = resolveGuiPath({
      platform: "macos",
      homeDir: "/Users/me",
      basePath: "/usr/bin:/bin",
      shell: "/bin/zsh",
      probeShellPath: () => wrap("/Users/me/.nvm/versions/node/v24/bin"),
    })
    const entries = result.split(":")
    // The version-manager shim the GUI's minimal PATH lacked must now come first.
    expect(entries[0]).toBe("/Users/me/.nvm/versions/node/v24/bin")
    expect(entries).toContain("/usr/bin")
  })

  it("invokes the shell probe with an interactive login shell command", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    resolveGuiPath({
      platform: "macos",
      homeDir: "/Users/me",
      basePath: "/usr/bin",
      shell: "/bin/zsh",
      probeShellPath: (command, args) => {
        calls.push({ command, args })
        return wrap("/opt/x/bin")
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe("/bin/zsh")
    expect(calls[0]?.args[0]).toBe("-ilc")
  })

  it("falls back to the common bin dirs when the shell probe fails", () => {
    const result = resolveGuiPath({
      platform: "macos",
      homeDir: "/Users/me",
      basePath: "/usr/bin",
      shell: "/bin/zsh",
      probeShellPath: () => null,
    })
    expect(result).toContain("/Users/me/.local/bin")
    expect(result).toContain("/opt/homebrew/bin")
    expect(result).toContain("/usr/bin")
  })

  it("does not probe and still includes common bin dirs when no shell is set", () => {
    let probed = false
    const result = resolveGuiPath({
      platform: "macos",
      homeDir: "/Users/me",
      basePath: "/usr/bin",
      shell: undefined,
      probeShellPath: () => {
        probed = true
        return wrap("/should/not/be/used")
      },
    })
    expect(probed).toBe(false)
    expect(result).toContain("/Users/me/.local/bin")
    expect(result).not.toContain("/should/not/be/used")
  })

  it("de-duplicates so an entry present in both the shell PATH and base appears once", () => {
    const result = resolveGuiPath({
      platform: "macos",
      homeDir: "/Users/me",
      basePath: "/usr/bin:/usr/local/bin",
      shell: "/bin/zsh",
      probeShellPath: () => wrap("/usr/local/bin"),
    })
    const occurrences = result.split(":").filter((e) => e === "/usr/local/bin")
    expect(occurrences).toHaveLength(1)
  })
})

describe("enrichGuiPathAsync", () => {
  const originalPath = process.env.PATH
  const originalShell = process.env.SHELL

  beforeEach(() => {
    __resetGuiPathAsyncForTest()
    process.env.PATH = originalPath
    // Force the function to exercise the probe branch on every host. The probe
    // is a mock so the value doesn't matter — any non-empty string works. On
    // Windows CI `process.env.SHELL` is undefined, which would otherwise skip
    // the probe and break the `expect(calls).toBe(1)` assertions in the tests
    // below.
    process.env.SHELL = "/bin/zsh"
  })
  afterAll(() => {
    process.env.PATH = originalPath
    process.env.SHELL = originalShell
  })

  it("resolves the PATH via the async probe and mutates process.env.PATH once settled", async () => {
    process.env.PATH = "/usr/bin:/bin"
    let calls = 0
    const probe: ShellPathProbeAsync = async () => {
      calls++
      return wrap("/Users/me/.nvm/versions/node/v24/bin")
    }
    const result = await enrichGuiPathAsync(probe)
    expect(calls).toBe(1)
    expect(result.split(":")[0]).toBe("/Users/me/.nvm/versions/node/v24/bin")
    expect(process.env.PATH).toBe(result)
  })

  it("memoizes: a second await does not invoke the probe again", async () => {
    let calls = 0
    const probe: ShellPathProbeAsync = async () => {
      calls++
      return wrap("/opt/x/bin")
    }
    await enrichGuiPathAsync(probe)
    await enrichGuiPathAsync(probe)
    expect(calls).toBe(1)
  })

  it("concurrent awaiters share one in-flight probe (no duplicate spawn)", async () => {
    let calls = 0
    const probe: ShellPathProbeAsync = async () => {
      calls++
      // yield once so concurrent awaiters both hit the in-flight promise
      await Promise.resolve()
      return wrap("/opt/y/bin")
    }
    const [a, b] = await Promise.all([
      enrichGuiPathAsync(probe),
      enrichGuiPathAsync(probe),
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it("falls back to the inherited PATH (never rejects) when the probe throws", async () => {
    process.env.PATH = "/usr/bin"
    const probe: ShellPathProbeAsync = async () => {
      throw new Error("spawn failed")
    }
    const result = await enrichGuiPathAsync(probe)
    // Platform-neutral contract: the async enricher must never reject, and the
    // inherited basePath must survive the fallback path. The OS-specific
    // "common bin dirs" branch is exercised by the pure `resolveGuiPath` unit
    // tests above (which pass `platform: "macos"` explicitly) — it is NOT a
    // property of the async enricher on its own.
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    const delimiter = process.platform === "win32" ? ";" : ":"
    expect(result.split(delimiter)).toContain("/usr/bin")
  })
})
