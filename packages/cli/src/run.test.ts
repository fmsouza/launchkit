import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"
import { createMemoryWriter } from "./writer"

type Captured = { msg: string; fields?: Record<string, unknown> | undefined }

const makeFakeLogger = (): { logger: Logger; errors: Captured[] } => {
  const errors: Captured[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, fields) => {
      errors.push({ msg, fields })
    },
    fatal: () => {},
    child: () => logger,
  }
  return { logger, errors }
}

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

  it("logs an error with { kind } via the injected logger when a command fails", async () => {
    const { logger, errors } = makeFakeLogger()
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out, logger }))(["frobnicate"])
    // The user-facing Result is unchanged.
    expect(result).toEqual({
      ok: false,
      error: { kind: "unknown-command", command: "frobnicate" },
    })
    // ...and the failure is logged with { kind } only (no argv/secrets).
    expect(errors).toEqual([
      { msg: "cli command failed", fields: { kind: "unknown-command" } },
    ])
  })

  it("does not log when the command succeeds", async () => {
    const { logger, errors } = makeFakeLogger()
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out, logger }))([
      "list",
      "harnesses",
    ])
    expect(result.ok).toBe(true)
    expect(errors).toEqual([])
  })
})
