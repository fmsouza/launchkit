import { describe, it, expect } from "bun:test"
import { ProviderIdSchema, AliasNameSchema, HarnessIdSchema, SessionIdSchema, SecretRefSchema } from "./ids"

describe("ProviderIdSchema", () => {
  it("parses a non-empty string into a branded ProviderId", () => {
    expect(ProviderIdSchema.parse("p_123")).toBe("p_123")
  })
  it("rejects an empty string", () => {
    expect(ProviderIdSchema.safeParse("").success).toBe(false)
  })
})

describe("SecretRefSchema", () => {
  it("parses an object with a non-empty ref", () => {
    expect(SecretRefSchema.parse({ ref: "kc_abc" })).toEqual({ ref: "kc_abc" })
  })
  it("rejects an object containing a raw secret value field", () => {
    expect(SecretRefSchema.safeParse({ ref: "kc_abc", value: "sk-xxx" }).success).toBe(false)
  })
})
