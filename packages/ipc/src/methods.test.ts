import { describe, it, expect } from "bun:test"
import {
  AddProviderParamsSchema,
  SetProviderSecretParamsSchema,
  LaunchHarnessParamsSchema,
  GetSessionsParamsSchema,
  IpcMethodSchemas,
} from "./methods"

describe("AddProviderParamsSchema", () => {
  it("parses an input with non-secret config and secret field names", () => {
    const input = {
      name: "OpenAI",
      sdkProvider: "openai",
      config: { baseUrl: "https://api.openai.com/v1" },
      secretFieldNames: ["apiKey"],
      models: ["gpt-4o"],
    }
    expect(AddProviderParamsSchema.parse(input)).toEqual(input)
  })
  it("rejects an add-provider input that smuggles a secret value", () => {
    const input = {
      name: "OpenAI",
      sdkProvider: "openai",
      config: { baseUrl: "x" },
      secretFieldNames: ["apiKey"],
      models: ["gpt-4o"],
      secrets: { apiKey: "sk-leak" },
    }
    expect(AddProviderParamsSchema.safeParse(input).success).toBe(false)
  })
})

describe("SetProviderSecretParamsSchema", () => {
  it("parses the only secret-bearing method's params", () => {
    const p = { providerId: "p_openai", field: "apiKey", value: "sk-secret" }
    expect(SetProviderSecretParamsSchema.parse(p)).toEqual(p)
  })
  it("rejects an empty secret value", () => {
    expect(SetProviderSecretParamsSchema.safeParse({ providerId: "p", field: "apiKey", value: "" }).success).toBe(false)
  })
})

describe("LaunchHarnessParamsSchema", () => {
  it("parses with an optional alias omitted", () => {
    expect(LaunchHarnessParamsSchema.parse({ id: "claude" })).toEqual({ id: "claude" })
  })
  it("parses with an alias provided", () => {
    expect(LaunchHarnessParamsSchema.parse({ id: "claude", alias: "fast" })).toEqual({ id: "claude", alias: "fast" })
  })
})

describe("GetSessionsParamsSchema", () => {
  it("parses an absent filter as undefined", () => {
    expect(GetSessionsParamsSchema.parse(undefined)).toBeUndefined()
  })
  it("parses a filter narrowing by harnessId", () => {
    expect(GetSessionsParamsSchema.parse({ harnessId: "claude" })).toEqual({ harnessId: "claude" })
  })
})

describe("IpcMethodSchemas", () => {
  it("exposes a params and result schema for every contract method", () => {
    const expected = [
      "getProviders", "addProvider", "updateProvider", "deleteProvider", "testProvider", "setProviderSecret",
      "getAliases", "addAlias", "updateAlias", "deleteAlias",
      "getHarnesses", "addHarness", "updateHarness", "deleteHarness", "launchHarness",
      "getSessions", "getProxyStatus",
    ] as const
    for (const name of expected) {
      expect(IpcMethodSchemas[name]).toBeDefined()
      expect(IpcMethodSchemas[name].params).toBeDefined()
      expect(IpcMethodSchemas[name].result).toBeDefined()
    }
  })
})
