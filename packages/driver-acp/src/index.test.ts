import { describe, expect, it } from "bun:test"
import * as exports from "./index"

describe("driver-acp barrel", () => {
  it("exports createAcpDriver", () => {
    expect(typeof exports.createAcpDriver).toBe("function")
  })

  it("exports mapAcpUpdate", () => {
    expect(typeof exports.mapAcpUpdate).toBe("function")
  })

  it("exports the ACP schema and types", () => {
    expect(exports.AcpSessionUpdateSchema).toBeDefined()
    expect(exports.AcpStopReasonSchema).toBeDefined()
  })
})
