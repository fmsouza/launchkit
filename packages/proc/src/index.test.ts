import { describe, expect, it } from "bun:test"
import {
  createFakeCommandResolver,
  createRecordingProcessSpawner,
  guardCommand,
} from "./index"

describe("guardCommand", () => {
  it("rejects a relative path when the command starts with ./", () => {
    const result = guardCommand("./local-server", "macos")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-command")
  })

  it("rejects path traversal when the command contains ..", () => {
    const result = guardCommand("/usr/../etc/passwd", "macos")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-command")
  })

  it("accepts a bare command name when it has no separators", () => {
    const result = guardCommand("git", "macos")
    expect(result.ok).toBe(true)
  })
})

describe("createFakeCommandResolver", () => {
  it("resolves a bare name to its table entry when the name is known", () => {
    const resolver = createFakeCommandResolver({ git: "/usr/bin/git" }, "macos")
    const result = resolver.resolve("git")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("/usr/bin/git")
  })

  it("fails with invalid-command when the name is not in the table", () => {
    const resolver = createFakeCommandResolver({}, "macos")
    const result = resolver.resolve("nope")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-command")
  })
})

describe("createRecordingProcessSpawner", () => {
  it("records the command, args, and env when spawn is called", () => {
    const spawner = createRecordingProcessSpawner(4242)
    const result = spawner.spawn("/usr/bin/git", ["clone", "url"], { A: "1" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.pid).toBe(4242)
    expect(spawner.calls).toEqual([
      { command: "/usr/bin/git", args: ["clone", "url"], env: { A: "1" } },
    ])
  })
})
