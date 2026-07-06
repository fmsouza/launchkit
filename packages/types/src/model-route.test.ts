import { describe, expect, it } from "bun:test"
import {
  ModelRouteSchema,
  WIRE_ALIAS_PREFIX,
  wireModelFor,
} from "./model-route"

describe("ModelRouteSchema", () => {
  it("parses a valid model route when all fields are present", () => {
    const parsed = ModelRouteSchema.parse({
      id: "mdl_123",
      providerId: "openai",
      providerModel: "gpt-4o",
    })
    expect(parsed.id).toBe<string>("mdl_123")
    expect(parsed.providerId).toBe<string>("openai")
    expect(parsed.providerModel).toBe("gpt-4o")
  })

  it("rejects an empty providerModel when parsing", () => {
    expect(
      ModelRouteSchema.safeParse({
        id: "mdl_123",
        providerId: "openai",
        providerModel: "",
      }).success,
    ).toBe(false)
  })

  it("rejects an empty id when parsing", () => {
    expect(
      ModelRouteSchema.safeParse({
        id: "",
        providerId: "openai",
        providerModel: "gpt-4o",
      }).success,
    ).toBe(false)
  })
})

describe("ModelRouteSchema aliases", () => {
  it("defaults aliases to [] when omitted", () => {
    const r = ModelRouteSchema.parse({
      id: "mdl_a",
      providerId: "p1",
      providerModel: "gpt-4o",
    })
    expect(r.aliases).toEqual([])
  })
  it("accepts an explicit aliases array", () => {
    const r = ModelRouteSchema.parse({
      id: "mdl_a",
      providerId: "p1",
      providerModel: "claude-haiku-4-5",
      aliases: ["haiku", "small"],
    })
    expect(r.aliases).toEqual(["haiku", "small"])
  })
})

const base = {
  id: "mdl_00000000-0000-4000-8000-000000000000",
  providerId: "p_00000000-0000-4000-8000-000000000000",
  providerModel: "gpt-4o",
}

describe("ModelRouteSchema attachments", () => {
  it("defaults attachments to {} for legacy entries without the field", () => {
    const parsed = ModelRouteSchema.parse(base)
    expect(parsed.attachments).toEqual({})
    expect(parsed.attachmentsSource).toBeUndefined()
  })

  it("accepts explicit capabilities with a source", () => {
    const parsed = ModelRouteSchema.parse({
      ...base,
      attachments: { image: true, pdf: false },
      attachmentsSource: "user",
    })
    expect(parsed.attachments.image).toBe(true)
    expect(parsed.attachmentsSource).toBe("user")
  })

  it("rejects unknown attachment keys (strict)", () => {
    const parsed = ModelRouteSchema.safeParse({
      ...base,
      attachments: { image: true, audio: true },
    })
    expect(parsed.success).toBe(false)
  })
})

describe("wireModelFor", () => {
  it("prefixes the id with the wire alias when the route can take images", () => {
    const route = ModelRouteSchema.parse({
      ...base,
      attachments: { image: true },
    })
    expect(wireModelFor(route)).toBe(`${WIRE_ALIAS_PREFIX}${base.id}`)
  })

  it("prefixes when only pdf is supported", () => {
    const route = ModelRouteSchema.parse({
      ...base,
      attachments: { pdf: true },
    })
    expect(wireModelFor(route)).toBe(`${WIRE_ALIAS_PREFIX}${base.id}`)
  })

  it("returns the raw id when capabilities are unknown or false", () => {
    expect(wireModelFor(ModelRouteSchema.parse(base))).toBe(base.id)
    expect(
      wireModelFor(
        ModelRouteSchema.parse({ ...base, attachments: { image: false } }),
      ),
    ).toBe(base.id)
  })
})
