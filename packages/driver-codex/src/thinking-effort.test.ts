import { describe, expect, it } from "bun:test"
import { toCodexReasoningEffort } from "./thinking-effort"

describe("toCodexReasoningEffort", () => {
  it("maps each canonical tier to a codex reasoning effort", () => {
    expect(toCodexReasoningEffort("off")).toBe("none")
    expect(toCodexReasoningEffort("minimal")).toBe("minimal")
    expect(toCodexReasoningEffort("low")).toBe("low")
    expect(toCodexReasoningEffort("medium")).toBe("medium")
    expect(toCodexReasoningEffort("high")).toBe("high")
    expect(toCodexReasoningEffort("max")).toBe("xhigh")
  })
})
