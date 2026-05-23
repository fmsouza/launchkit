import { describe, expect, it } from "bun:test"
import { parseArgs } from "./parse-args"

describe("parseArgs", () => {
  it("returns an empty command and no rest when given an empty argv", () => {
    expect(parseArgs([])).toEqual({ command: "", rest: [], flags: {} })
  })

  it("treats the first token as the command and the rest as positionals when no flags are present", () => {
    expect(parseArgs(["launch", "claude"])).toEqual({
      command: "launch",
      rest: ["claude"],
      flags: {},
    })
  })

  it("parses a --key value pair into a string flag when a value follows the key", () => {
    expect(parseArgs(["launch", "claude", "--model", "fast"])).toEqual({
      command: "launch",
      rest: ["claude"],
      flags: { model: "fast" },
    })
  })

  it("parses a bare --flag into a boolean true when the next token is another flag", () => {
    expect(parseArgs(["list", "--json", "--verbose"])).toEqual({
      command: "list",
      rest: [],
      flags: { json: true, verbose: true },
    })
  })

  it("parses a trailing bare --flag into a boolean true when it is the last token", () => {
    expect(parseArgs(["list", "harnesses", "--json"])).toEqual({
      command: "list",
      rest: ["harnesses"],
      flags: { json: true },
    })
  })

  it("collects multiple positionals between and after flags as rest", () => {
    expect(parseArgs(["add", "provider", "--id", "p_x", "extra"])).toEqual({
      command: "add",
      rest: ["provider", "extra"],
      flags: { id: "p_x" },
    })
  })
})
