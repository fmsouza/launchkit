import { describe, expect, it } from "bun:test"
import type { AcpConfigOption } from "./acp-client"
import {
  pickEffortOption,
  pickModeOption,
  pickModelOption,
} from "./config-options"

const MODEL: AcpConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  values: [
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus" },
  ],
}

const EFFORT: AcpConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  category: "thought_level",
  values: [
    { id: "low", name: "Low" },
    { id: "high", name: "High" },
  ],
}

const MODE: AcpConfigOption = {
  id: "mode",
  name: "Session Mode",
  category: "mode",
  values: [
    { id: "build", name: "build" },
    { id: "plan", name: "plan" },
  ],
}

describe("pickModelOption", () => {
  it("finds the model option by category and the value matching the model id", () => {
    expect(pickModelOption([MODEL, EFFORT], "opus")).toEqual({
      configId: "model",
      valueId: "opus",
    })
  })

  it("falls back to matching the option id when the agent sends no category", () => {
    const uncategorized: AcpConfigOption = {
      id: MODEL.id,
      name: MODEL.name,
      values: MODEL.values,
    }
    expect(pickModelOption([uncategorized], "opus")).toEqual({
      configId: "model",
      valueId: "opus",
    })
  })

  it("matches a value by display name when the id does not match", () => {
    expect(pickModelOption([MODEL], "Opus")).toEqual({
      configId: "model",
      valueId: "opus",
    })
  })

  it("returns undefined when the agent advertises no model option", () => {
    expect(pickModelOption([EFFORT], "opus")).toBeUndefined()
  })

  it("returns undefined when the model option has no matching value", () => {
    expect(pickModelOption([MODEL], "gpt-9")).toBeUndefined()
  })
})

describe("pickEffortOption", () => {
  it("maps a Spectrum effort tier onto the agent's effort value", () => {
    expect(pickEffortOption([MODEL, EFFORT], "high")).toEqual({
      configId: "reasoning_effort",
      valueId: "high",
    })
  })

  it("matches the effort value case-insensitively by name", () => {
    const named: AcpConfigOption = {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      values: [{ id: "eff_2", name: "High" }],
    }
    expect(pickEffortOption([named], "high")).toEqual({
      configId: "effort",
      valueId: "eff_2",
    })
  })

  it("returns undefined when the agent advertises no effort option", () => {
    expect(pickEffortOption([MODEL], "high")).toBeUndefined()
  })

  it("returns undefined when the effort option lacks the requested tier", () => {
    expect(pickEffortOption([EFFORT], "max")).toBeUndefined()
  })
})

describe("pickModeOption", () => {
  it("finds the agent's mode option by category", () => {
    // opencode advertises its modes as a config option (category "mode"), NOT via session/new's
    // `modes` field — verified against a live `opencode acp` process.
    expect(pickModeOption([MODEL, MODE])).toEqual(MODE)
  })

  it("returns undefined when the agent advertises no mode option", () => {
    expect(pickModeOption([MODEL, EFFORT])).toBeUndefined()
  })
})
