import { describe, it, expect } from "bun:test"
import { isOk } from "@launchkit/utils"
import { createInMemoryConfigFile } from "./file"

describe("createInMemoryConfigFile", () => {
  it("reports exists=false and returns not-found from read when created empty", async () => {
    const file = createInMemoryConfigFile()
    expect(await file.exists()).toBe(false)
    expect(await file.read()).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("reports exists=true and reads back the initial contents when seeded", async () => {
    const file = createInMemoryConfigFile('{"hello":"world"}')
    expect(await file.exists()).toBe(true)
    expect(await file.read()).toEqual({ ok: true, value: '{"hello":"world"}' })
  })

  it("records each write and makes the latest contents readable after writeAtomic", async () => {
    const file = createInMemoryConfigFile()
    const written = await file.writeAtomic("first")
    expect(isOk(written)).toBe(true)
    await file.writeAtomic("second")

    expect(file.writes).toEqual(["first", "second"])
    expect(await file.exists()).toBe(true)
    expect(await file.read()).toEqual({ ok: true, value: "second" })
  })

  it("exposes only whole writes — there is never a partially written value", async () => {
    const file = createInMemoryConfigFile()
    await file.writeAtomic("complete-document")
    // Every recorded write is a complete string; the fake mirrors the real adapter's atomic rename.
    for (const recorded of file.writes) {
      expect(recorded).toBe("complete-document")
    }
    expect(await file.read()).toEqual({ ok: true, value: "complete-document" })
  })
})
