import { describe, expect, it } from "bun:test"
import { createMemoryWriter } from "./writer"

describe("createMemoryWriter", () => {
  it("records each line in order when write() is called", () => {
    const writer = createMemoryWriter()
    writer.write("first")
    writer.write("second")
    expect(writer.lines).toEqual(["first", "second"])
  })

  it("exposes no lines when nothing has been written", () => {
    expect(createMemoryWriter().lines).toEqual([])
  })
})
