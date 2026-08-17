import { describe, expect, it } from "bun:test"
import { createGuardedOpenExternal } from "./open-external"

describe("createGuardedOpenExternal", () => {
  it("refuses a url whose scheme is not http or https", async () => {
    const opened: string[] = []
    const open = createGuardedOpenExternal(async (url) => {
      opened.push(url)
      return true
    })
    const r = await open("file:///etc/passwd")
    expect(r.ok).toBe(false)
    expect(opened).toEqual([])
  })

  it("refuses a javascript url", async () => {
    const opened: string[] = []
    const open = createGuardedOpenExternal(async (url) => {
      opened.push(url)
      return true
    })
    expect((await open("javascript:alert(1)")).ok).toBe(false)
    expect(opened).toEqual([])
  })

  it("hands an https url to the capability unchanged", async () => {
    const opened: string[] = []
    const open = createGuardedOpenExternal(async (url) => {
      opened.push(url)
      return true
    })
    const r = await open("https://example.com/auth?a=1&b=2")
    expect(r.ok).toBe(true)
    expect(opened).toEqual(["https://example.com/auth?a=1&b=2"])
  })

  it("fails when the OS refuses to open the url", async () => {
    const open = createGuardedOpenExternal(async () => false)
    const r = await open("https://example.com/auth")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("write-failed")
  })

  it("fails rather than throwing when the capability rejects", async () => {
    const open = createGuardedOpenExternal(async () => {
      throw new Error("native boom")
    })
    const r = await open("https://example.com/auth")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("write-failed")
  })
})
