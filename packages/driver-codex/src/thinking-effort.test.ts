import { describe, expect, it } from "bun:test"
import { toCodexReasoningEffort } from "./thinking-effort"

describe("toCodexReasoningEffort", () => {
  it("maps tiers to codex reasoning effort", () => {
    expect(toCodexReasoningEffort("low", "gpt-5-codex")).toBe("low")
    expect(toCodexReasoningEffort("max", "gpt-5-codex")).toBe("xhigh")
  })

  it("returns undefined for the off tier", () => {
    expect(toCodexReasoningEffort("off", "gpt-5-codex")).toBeUndefined()
  })
})
