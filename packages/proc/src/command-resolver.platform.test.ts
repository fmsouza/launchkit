import { describe, expect, it } from "bun:test"
import { createFakeCommandResolver, guardCommand } from "./command-resolver"

describe("guardCommand (platform-aware)", () => {
  it("accepts a Windows drive-absolute path when platform is windows", () => {
    expect(guardCommand("C:\\tools\\claude.exe", "windows")).toEqual({
      ok: true,
      value: "C:\\tools\\claude.exe",
    })
  })
  it("rejects a Windows relative .\\ path when platform is windows", () => {
    const r = guardCommand(".\\claude.exe", "windows")
    expect(r.ok).toBe(false)
  })
  it("rejects path traversal using a backslash separator on windows", () => {
    const r = guardCommand("foo\\..\\bar", "windows")
    expect(r.ok).toBe(false)
  })
})

describe("createFakeCommandResolver (platform-aware)", () => {
  it("passes a Windows absolute path straight through when platform is windows", () => {
    const resolver = createFakeCommandResolver({}, "windows")
    expect(resolver.resolve("C:\\tools\\claude.exe")).toEqual({
      ok: true,
      value: "C:\\tools\\claude.exe",
    })
  })
  it("resolves a bare name via the path table on windows", () => {
    const resolver = createFakeCommandResolver(
      { claude: "C:\\tools\\claude.exe" },
      "windows",
    )
    expect(resolver.resolve("claude")).toEqual({
      ok: true,
      value: "C:\\tools\\claude.exe",
    })
  })
})
