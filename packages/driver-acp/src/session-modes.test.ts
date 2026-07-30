import { describe, expect, it } from "bun:test"
import { pickAcpModeId, supportedModesFrom } from "./session-modes"

describe("pickAcpModeId", () => {
  it("maps manual to the agent's default mode id", () => {
    expect(pickAcpModeId("manual", ["default", "acceptEdits", "plan"])).toBe(
      "default",
    )
  })

  it("maps auto-edits to the agent's acceptEdits mode id", () => {
    expect(pickAcpModeId("auto-edits", ["default", "acceptEdits"])).toBe(
      "acceptEdits",
    )
  })

  it("maps plan to the agent's plan mode id", () => {
    expect(pickAcpModeId("plan", ["default", "plan"])).toBe("plan")
  })

  it("maps bypass to the agent's bypassPermissions mode id", () => {
    expect(pickAcpModeId("bypass", ["default", "bypassPermissions"])).toBe(
      "bypassPermissions",
    )
  })

  it("matches a mode id ignoring case and separators", () => {
    expect(pickAcpModeId("auto-edits", ["accept_edits"])).toBe("accept_edits")
  })

  it("returns undefined when the agent advertises no matching mode", () => {
    expect(pickAcpModeId("plan", ["default"])).toBeUndefined()
  })

  it("returns undefined when the agent advertises no modes at all", () => {
    expect(pickAcpModeId("manual", [])).toBeUndefined()
  })

  it("maps manual to opencode's build mode", () => {
    // opencode names its default working mode "build" and its read-only one "plan".
    expect(pickAcpModeId("manual", ["build", "plan"])).toBe("build")
  })
})

describe("supportedModesFrom", () => {
  it("reports only the Spectrum modes the agent can actually honor", () => {
    expect(supportedModesFrom(["default", "plan"])).toEqual(["manual", "plan"])
  })

  it("reports no modes when the agent advertises none", () => {
    expect(supportedModesFrom([])).toEqual([])
  })

  it("reports every mode when the agent advertises the full Claude set", () => {
    expect(
      supportedModesFrom([
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ]),
    ).toEqual(["manual", "auto-edits", "plan", "bypass"])
  })
})
