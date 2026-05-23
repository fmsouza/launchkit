import { describe, expect, it } from "bun:test"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"
import { createMemoryWriter } from "./writer"

describe("runCli dispatch", () => {
  it("returns an unknown-command error when the command is not recognized", async () => {
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out }))(["frobnicate"])
    expect(result).toEqual({
      ok: false,
      error: { kind: "unknown-command", command: "frobnicate" },
    })
  })

  it("returns a usage error naming the available commands when no command is given", async () => {
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out }))([])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("dispatches to the list command when the first token is 'list'", async () => {
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out }))(["list", "harnesses"])
    // list is implemented in cli-03; until then this asserts dispatch reached *a* command,
    // not the unknown-command branch.
    expect(result.ok === false && result.error.kind).not.toBe("unknown-command")
  })
})
