import { describe, expect, it } from "bun:test"
import { type Result, ok } from "@spectrum/utils"
import type { SecretError } from "./backend"
import { createPlatformKeychainBackend } from "./platform-keychain-backend"
import type { ProcessRunner } from "./process-runner"
import { createInMemorySecretFileOps } from "./secret-file-ops"

type Call = {
  command: string
  args: readonly string[]
  stdin?: string | undefined
}
const recordingRunner = (
  results: ReadonlyArray<Result<{ stdout: string }, SecretError>>,
) => {
  const calls: Call[] = []
  let i = 0
  const runner: ProcessRunner = {
    run: async (command, args, opts) => {
      calls.push({ command, args, stdin: opts?.stdin })
      return results[i++] ?? ok({ stdout: "" })
    },
  }
  return { runner, calls }
}

const baseDeps = () => ({
  fileOps: createInMemorySecretFileOps(),
  secretsDir: "/data/secrets",
  secretPassphrase: async () => "pw",
  keychainService: "spectrum",
})

describe("createPlatformKeychainBackend", () => {
  it("uses the macOS security CLI when platform is macos", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "" })])
    const backend = createPlatformKeychainBackend({
      platform: "macos",
      runner,
      ...baseDeps(),
    })
    await backend.add("kc_1", "s")
    expect(calls[0]?.command).toBe("security")
  })

  it("uses secret-tool on linux when a Secret Service is available", async () => {
    // 1st run = probe lookup (ok), 2nd run = store
    const { runner, calls } = recordingRunner([
      ok({ stdout: "" }),
      ok({ stdout: "" }),
    ])
    const backend = createPlatformKeychainBackend({
      platform: "linux",
      runner,
      ...baseDeps(),
      commandExists: () => true,
    })
    await backend.add("kc_1", "s")
    expect(calls[1]?.command).toBe("secret-tool")
    expect(calls[1]?.args[0]).toBe("store")
  })

  it("falls back to the encrypted file on linux when no Secret Service is available", async () => {
    const fileOps = createInMemorySecretFileOps()
    const { runner, calls } = recordingRunner([])
    const backend = createPlatformKeychainBackend({
      platform: "linux",
      runner,
      fileOps,
      secretsDir: "/data/secrets",
      secretPassphrase: async () => "pw",
      keychainService: "spectrum",
      commandExists: () => false, // secret-tool not installed
    })
    expect((await backend.add("kc_1", "s")).ok).toBe(true)
    expect(calls).toHaveLength(0)
    expect(await backend.find("kc_1")).toEqual({ ok: true, value: "s" })
  })

  it("uses the DPAPI-encrypted file + powershell on windows", async () => {
    const fileOps = createInMemorySecretFileOps()
    const protectedB64 = Buffer.from("protected").toString("base64")
    const { runner, calls } = recordingRunner([ok({ stdout: protectedB64 })])
    const backend = createPlatformKeychainBackend({
      platform: "windows",
      runner,
      fileOps,
      secretsDir: "/data/secrets",
      secretPassphrase: async () => null,
      keychainService: "spectrum",
    })
    expect((await backend.add("kc_1", "s")).ok).toBe(true)
    expect(calls[0]?.command).toBe("powershell")
  })

  it("uses an in-memory backend for an unknown platform", async () => {
    const { runner } = recordingRunner([])
    const backend = createPlatformKeychainBackend({
      platform: "unknown",
      runner,
      ...baseDeps(),
    })
    await backend.add("kc_1", "s")
    expect(await backend.find("kc_1")).toEqual({ ok: true, value: "s" })
  })

  it("passes keychainService to the macOS backend so dev writes under spectrum-dev", async () => {
    const calls: { args: readonly string[] }[] = []
    const runner: ProcessRunner = {
      run: async (_cmd: string, args: readonly string[]) => {
        calls.push({ args })
        return ok({ stdout: "" })
      },
    }
    const backend = createPlatformKeychainBackend({
      platform: "macos",
      runner,
      fileOps: createInMemorySecretFileOps(),
      secretsDir: "/tmp/secrets",
      secretPassphrase: async () => null,
      keychainService: "spectrum-dev",
    })

    await backend.add("kc_1", "sk")

    expect(calls[0]?.args).toContain("spectrum-dev")
  })
})
