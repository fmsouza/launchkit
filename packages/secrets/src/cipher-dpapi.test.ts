import { describe, expect, it } from "bun:test"
import { type Result, ok } from "@spectrum/utils"
import type { SecretError } from "./backend"
import { createDpapiCipher } from "./cipher-dpapi"
import type { ProcessRunner } from "./process-runner"

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

describe("createDpapiCipher", () => {
  it("invokes powershell, passes base64(plaintext) on stdin, and returns its stdout as the envelope", async () => {
    const { runner, calls } = recordingRunner([
      ok({ stdout: "PROTECTED_B64\n" }),
    ])
    const cipher = createDpapiCipher({ runner })
    const enc = await cipher.encrypt("hello")
    expect(enc).toEqual({ ok: true, value: "PROTECTED_B64" })
    expect(calls[0]?.command).toBe("powershell")
    expect(calls[0]?.args).toContain("-NoProfile")
    expect(calls[0]?.stdin).toBe(
      Buffer.from("hello", "utf8").toString("base64"),
    )
  })

  it("decrypts by passing the envelope on stdin and decoding the base64 plaintext stdout", async () => {
    const b64Hello = Buffer.from("hello", "utf8").toString("base64")
    const { runner, calls } = recordingRunner([ok({ stdout: `${b64Hello}\n` })])
    const cipher = createDpapiCipher({ runner })
    const dec = await cipher.decrypt("PROTECTED_B64")
    expect(dec).toEqual({ ok: true, value: "hello" })
    expect(calls[0]?.stdin).toBe("PROTECTED_B64")
  })
})
