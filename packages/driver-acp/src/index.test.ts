import { describe, expect, it } from "bun:test"
import * as exports from "./index"

describe("driver-acp barrel", () => {
  it("exports createAcpDriver", () => {
    expect(typeof exports.createAcpDriver).toBe("function")
  })

  it("exports the real transport factories", () => {
    // The composition root needs `createRealAcpConnect` to inject an enriched baseEnv (the
    // packaged GUI inherits a minimal launchd PATH), so it belongs on the public surface.
    expect(typeof exports.createRealAcpConnect).toBe("function")
    expect(typeof exports.createAcpClient).toBe("function")
  })

  it("exports mapAcpUpdate", () => {
    expect(typeof exports.mapAcpUpdate).toBe("function")
  })

  it("exports the ACP schema and types", () => {
    expect(exports.AcpSessionUpdateSchema).toBeDefined()
    expect(exports.AcpStopReasonSchema).toBeDefined()
  })

  it("exports the pure session-mode helpers", () => {
    expect(typeof exports.pickAcpModeId).toBe("function")
    expect(typeof exports.supportedModesFrom).toBe("function")
  })

  it("exports the pure permission-outcome helper", () => {
    expect(typeof exports.pickPermissionOptionId).toBe("function")
  })

  it("exports the pure config-option pickers", () => {
    expect(typeof exports.pickModelOption).toBe("function")
    expect(typeof exports.pickEffortOption).toBe("function")
    expect(typeof exports.pickModeOption).toBe("function")
  })

  it("exports the pure prompt-block builder", () => {
    expect(typeof exports.toAcpPromptBlocks).toBe("function")
  })

  it("exports the pure elicitation helpers", () => {
    expect(typeof exports.elicitationToQuestion).toBe("function")
    expect(typeof exports.answerToElicitationResponse).toBe("function")
    expect(typeof exports.firstPropertyName).toBe("function")
  })
})
