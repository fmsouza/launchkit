import { describe, expect, it } from "bun:test"
import { type Result, err, ok } from "@spectrum/utils"
import type { SecretError } from "./backend"
import type { ProcessRunner } from "./process-runner"
import { createSecretToolBackend } from "./secret-tool-backend"

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

describe("createSecretToolBackend", () => {
  it("stores via 'secret-tool store' with the secret on stdin (never argv) when add is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "" })])
    const r = await createSecretToolBackend({ runner }).add("kc_1", "sk-secret")
    expect(r).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.command).toBe("secret-tool")
    expect(calls[0]?.args).toEqual([
      "store",
      "--label=Spectrum: kc_1",
      "service",
      "spectrum",
      "account",
      "kc_1",
    ])
    expect(calls[0]?.stdin).toBe("sk-secret")
    expect(calls[0]?.args.join(" ")).not.toContain("sk-secret")
  })

  it("looks up via 'secret-tool lookup' and returns the stdout secret when find is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "sk-secret" })])
    const r = await createSecretToolBackend({ runner }).find("kc_1")
    expect(r).toEqual({ ok: true, value: "sk-secret" })
    expect(calls[0]?.args).toEqual([
      "lookup",
      "service",
      "spectrum",
      "account",
      "kc_1",
    ])
  })

  it("maps a failed lookup to not-found when find is called for a missing account", async () => {
    const { runner } = recordingRunner([
      err({ kind: "backend-failed", detail: "exit 1: " }),
    ])
    const r = await createSecretToolBackend({ runner }).find("missing")
    expect(r).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("clears via 'secret-tool clear' when remove is called", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "" })])
    const r = await createSecretToolBackend({ runner }).remove("kc_1")
    expect(r).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.args).toEqual([
      "clear",
      "service",
      "spectrum",
      "account",
      "kc_1",
    ])
  })

  it("redacts the secret out of a failed-add error detail", async () => {
    const { runner } = recordingRunner([
      err({
        kind: "backend-failed",
        detail: "store failed near sk-secret end",
      }),
    ])
    const r = await createSecretToolBackend({ runner }).add("kc_1", "sk-secret")
    expect(r.ok).toBe(false)
    if (r.ok || r.error.kind !== "backend-failed") return
    expect(r.error.detail).not.toContain("sk-secret")
    expect(r.error.detail).toContain("[REDACTED]")
  })

  it("uses the provided service name (spectrum-dev) in the lookup arg array", async () => {
    const { runner, calls } = recordingRunner([ok({ stdout: "sk\n" })])
    const backend = createSecretToolBackend({ runner, service: "spectrum-dev" })

    await backend.find("kc_1")

    expect(calls[0]?.args).toEqual([
      "lookup",
      "service",
      "spectrum-dev",
      "account",
      "kc_1",
    ])
  })
})
