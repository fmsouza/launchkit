import { describe, expect, it } from "bun:test"
import { DiscoveredModelSchema } from "./discovered-model"

describe("DiscoveredModelSchema", () => {
  it("accepts an id-only entry and an entry with capabilities", () => {
    expect(DiscoveredModelSchema.safeParse({ id: "gpt-4o" }).success).toBe(true)
    expect(
      DiscoveredModelSchema.safeParse({
        id: "llava:13b",
        attachments: { image: true, pdf: false },
      }).success,
    ).toBe(true)
  })

  it("rejects an empty id and unknown keys", () => {
    expect(DiscoveredModelSchema.safeParse({ id: "" }).success).toBe(false)
    expect(DiscoveredModelSchema.safeParse({ id: "x", extra: 1 }).success).toBe(
      false,
    )
  })
})
