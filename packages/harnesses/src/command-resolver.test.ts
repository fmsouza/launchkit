import { describe, expect, it } from "bun:test"
import { createFakeCommandResolver } from "./command-resolver"

describe("createFakeCommandResolver", () => {
  it("returns the configured absolute path for a bare command on PATH", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    expect(resolver.resolve("claude")).toEqual({
      ok: true,
      value: "/usr/local/bin/claude",
    })
  })

  it("accepts an already-absolute command and returns it unchanged", () => {
    const resolver = createFakeCommandResolver({})
    expect(resolver.resolve("/opt/tools/codex")).toEqual({
      ok: true,
      value: "/opt/tools/codex",
    })
  })

  it("rejects a relative command with an invalid-command error", () => {
    const resolver = createFakeCommandResolver({})
    expect(resolver.resolve("./local-bin")).toEqual({
      ok: false,
      error: {
        kind: "invalid-command",
        detail: "relative paths are not allowed: ./local-bin",
      },
    })
  })

  it("rejects any path containing '..' with an invalid-command error", () => {
    const resolver = createFakeCommandResolver({})
    expect(resolver.resolve("/usr/bin/../bin/claude")).toEqual({
      ok: false,
      error: {
        kind: "invalid-command",
        detail: "path traversal is not allowed: /usr/bin/../bin/claude",
      },
    })
  })

  it("rejects a bare command that is not on the fake PATH", () => {
    const resolver = createFakeCommandResolver({})
    const r = resolver.resolve("ghost")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-command")
  })
})
