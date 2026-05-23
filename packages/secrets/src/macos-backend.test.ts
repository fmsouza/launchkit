import { describe, it, expect } from "bun:test"
import { type Result, ok, err } from "@launchkit/utils"
import type { SecretError, KeychainBackend } from "./backend"
import type { ProcessRunner } from "./process-runner"
import { createMacosSecurityBackend } from "./macos-backend"

type Call = { readonly command: string; readonly args: readonly string[] }

/** Records every invocation and replays a queued result per call. */
const recordingRunner = (
  results: ReadonlyArray<Result<{ stdout: string }, SecretError>>,
): { runner: ProcessRunner; calls: Call[] } => {
  const calls: Call[] = []
  let i = 0
  const runner: ProcessRunner = {
    run: async (command, args) => {
      calls.push({ command, args })
      const result = results[i] ?? ok({ stdout: "" })
      i += 1
      return result
    },
  }
  return { runner, calls }
}

describe("createMacosSecurityBackend", () => {
  it("invokes the security CLI with the exact add-generic-password arg array when add is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "" })])
    const backend: KeychainBackend = createMacosSecurityBackend({ runner })

    const result = await backend.add("kc_1", "sk-secret")

    expect(result).toEqual({ ok: true, value: undefined })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe("security")
    expect(calls[0]?.args).toEqual([
      "add-generic-password", "-a", "kc_1", "-s", "launchkit", "-w", "sk-secret", "-U",
    ])
  })

  it("invokes the exact find-generic-password arg array and trims the trailing newline from stdout when find is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "sk-secret\n" })])
    const backend = createMacosSecurityBackend({ runner })

    const result = await backend.find("kc_1")

    expect(result).toEqual({ ok: true, value: "sk-secret" })
    expect(calls[0]?.args).toEqual([
      "find-generic-password", "-a", "kc_1", "-s", "launchkit", "-w",
    ])
  })

  it("invokes the exact delete-generic-password arg array when remove is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "" })])
    const backend = createMacosSecurityBackend({ runner })

    const result = await backend.remove("kc_1")

    expect(result).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.args).toEqual([
      "delete-generic-password", "-a", "kc_1", "-s", "launchkit",
    ])
  })

  it("redacts the secret value out of the error detail so a failed add never leaks the key", async () => {
    const { runner } = recordingRunner([
      err({ kind: "backend-failed", detail: "security: write failed for sk-secret near keychain" }),
    ])
    const backend = createMacosSecurityBackend({ runner })

    const result = await backend.add("kc_1", "sk-secret")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("backend-failed")
    if (result.error.kind !== "backend-failed") return
    expect(result.error.detail).not.toContain("sk-secret")
    expect(result.error.detail).toContain("[REDACTED]")
  })

  it("passes a not-found error through unchanged when find reports the account is missing", async () => {
    const { runner } = recordingRunner([err({ kind: "not-found" })])
    const backend = createMacosSecurityBackend({ runner })

    const result = await backend.find("kc_missing")

    expect(result).toEqual({ ok: false, error: { kind: "not-found" } })
  })
})
