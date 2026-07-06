import { describe, expect, it } from "bun:test"
import type { ModelRoute } from "@spectrum/types"
import { sortModelIds, sortModelRoutes, sortProviderViews } from "./model-sort"

const route = (
  id: string,
  providerId: string,
  providerModel: string,
): ModelRoute => ({ id, providerId, providerModel }) as unknown as ModelRoute

describe("sortModelIds", () => {
  it("sorts model ids alphabetically, case-insensitive", () => {
    expect(sortModelIds(["Zeta", "alpha", "Beta"])).toEqual([
      "alpha",
      "Beta",
      "Zeta",
    ])
  })

  it("orders numerically so claude-3 sorts before claude-10", () => {
    expect(sortModelIds(["claude-10", "claude-3", "claude-3.5"])).toEqual([
      "claude-3",
      "claude-3.5",
      "claude-10",
    ])
  })

  it("does not mutate the input array", () => {
    const input = ["c", "a", "b"]
    const snapshot = [...input]
    sortModelIds(input)
    expect(input).toEqual(snapshot)
  })

  it("returns an empty array unchanged", () => {
    expect(sortModelIds([])).toEqual([])
  })
})

describe("sortModelRoutes", () => {
  it("orders by provider display name then providerModel", () => {
    const names: Record<string, string> = {
      p_anthropic: "Anthropic",
      p_openai: "OpenAI",
    }
    const input = [
      route("m2", "p_openai", "gpt-4o"),
      route("m1", "p_anthropic", "claude-sonnet"),
      route("m3", "p_anthropic", "claude-haiku"),
    ]
    expect(sortModelRoutes(input, (id) => names[id])).toEqual([
      route("m3", "p_anthropic", "claude-haiku"),
      route("m1", "p_anthropic", "claude-sonnet"),
      route("m2", "p_openai", "gpt-4o"),
    ])
  })

  it("falls back to providerId when no display name is resolved", () => {
    const input = [route("m2", "p_zeta", "x"), route("m1", "p_alpha", "y")]
    expect(sortModelRoutes(input, () => undefined)).toEqual([
      route("m1", "p_alpha", "y"),
      route("m2", "p_zeta", "x"),
    ])
  })

  it("sorts case-insensitively and numerically", () => {
    const names: Record<string, string> = { p1: "anthropic" }
    const input = [
      route("m1", "p1", "claude-10"),
      route("m2", "p1", "Claude-3"),
      route("m3", "p1", "claude-3.5"),
    ]
    expect(sortModelRoutes(input, (id) => names[id])).toEqual([
      route("m2", "p1", "Claude-3"),
      route("m3", "p1", "claude-3.5"),
      route("m1", "p1", "claude-10"),
    ])
  })

  it("is stable: equal keys preserve input order", () => {
    const input = [
      route("m_first", "p1", "same-model"),
      route("m_second", "p1", "same-model"),
    ]
    expect(sortModelRoutes(input, () => "P")).toEqual([
      route("m_first", "p1", "same-model"),
      route("m_second", "p1", "same-model"),
    ])
  })

  it("does not mutate the input array", () => {
    const input = [
      route("m2", "p_openai", "gpt-4o"),
      route("m1", "p_anthropic", "claude"),
    ]
    const snapshot = [...input]
    sortModelRoutes(input, () => undefined)
    expect(input).toEqual(snapshot)
  })

  it("returns an empty array unchanged", () => {
    expect(sortModelRoutes([], () => undefined)).toEqual([])
  })
})

describe("sortProviderViews", () => {
  const view = (id: string, name: string) => ({ id, name })

  it("orders by display name", () => {
    const input = [
      view("p_openai", "OpenAI"),
      view("p_anthropic", "Anthropic"),
      view("p_bedrock", "Bedrock"),
    ]
    expect(sortProviderViews(input)).toEqual([
      view("p_anthropic", "Anthropic"),
      view("p_bedrock", "Bedrock"),
      view("p_openai", "OpenAI"),
    ])
  })

  it("breaks name ties by id", () => {
    const input = [view("p_b", "Acme"), view("p_a", "Acme")]
    expect(sortProviderViews(input)).toEqual([
      view("p_a", "Acme"),
      view("p_b", "Acme"),
    ])
  })

  it("sorts case-insensitively and numerically", () => {
    const input = [view("p1", "provider-10"), view("p2", "Provider-2")]
    expect(sortProviderViews(input)).toEqual([
      view("p2", "Provider-2"),
      view("p1", "provider-10"),
    ])
  })

  it("does not mutate the input array", () => {
    const input = [view("p_b", "B"), view("p_a", "A")]
    const snapshot = [...input]
    sortProviderViews(input)
    expect(input).toEqual(snapshot)
  })

  it("returns an empty array unchanged", () => {
    expect(sortProviderViews([])).toEqual([])
  })
})
