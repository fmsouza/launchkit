import { describe, expect, it } from "bun:test"
import { getDescriptor } from "./catalog"
import { resolveReasoning } from "./resolve-reasoning"

describe("resolveReasoning", () => {
  it("returns the provider default when the model is unknown", () => {
    expect(
      resolveReasoning(getDescriptor("anthropic"), "some-future-model").shape,
    ).toBe("anthropic-thinking")
    expect(resolveReasoning(getDescriptor("openai"), undefined).shape).toBe(
      "openai-effort",
    )
  })

  it("downgrades non-thinking Claude Haiku 3.x to none", () => {
    expect(
      resolveReasoning(getDescriptor("anthropic"), "claude-3-5-haiku-20241022")
        .shape,
    ).toBe("none")
  })

  it("downgrades OpenAI non-reasoning chat models to none", () => {
    expect(resolveReasoning(getDescriptor("openai"), "gpt-4o").shape).toBe(
      "none",
    )
    expect(resolveReasoning(getDescriptor("openai"), "gpt-4o-mini").shape).toBe(
      "none",
    )
  })

  it("keeps OpenAI reasoning models on openai-effort", () => {
    expect(resolveReasoning(getDescriptor("openai"), "gpt-5").shape).toBe(
      "openai-effort",
    )
    expect(resolveReasoning(getDescriptor("openai"), "o3-mini").shape).toBe(
      "openai-effort",
    )
  })
})
