import { describe, expect, it } from "bun:test"
import * as cli from "./index"
import { createMemoryWriter, parseArgs, runCli } from "./index"
import { makeFakeDeps } from "./test-support"

describe("@launchkit/cli barrel", () => {
  it("exports parseArgs, runCli, the commands, and the writer factory when imported", () => {
    for (const name of [
      "parseArgs",
      "runCli",
      "list",
      "launchCommand",
      "add",
      "remove",
      "createMemoryWriter",
    ]) {
      expect(cli).toHaveProperty(name)
    }
  })

  it("parses argv into a command, rest, and flags through the public parseArgs", () => {
    expect(parseArgs(["launch", "claude", "--model", "fast"])).toEqual({
      command: "launch",
      rest: ["claude"],
      flags: { model: "fast" },
    })
  })

  it("runs an unknown command to an unknown-command error through the public runCli", async () => {
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out }))(["bogus"])
    expect(result).toEqual({
      ok: false,
      error: { kind: "unknown-command", command: "bogus" },
    })
  })
})
