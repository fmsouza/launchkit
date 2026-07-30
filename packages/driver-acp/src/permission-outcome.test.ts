import { describe, expect, it } from "bun:test"
import type { AcpPermissionOption } from "./acp-client"
import { pickPermissionOptionId } from "./permission-outcome"

const OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
]

describe("pickPermissionOptionId", () => {
  it("picks the allow_once option when the user allows", () => {
    expect(pickPermissionOptionId("allow", OPTIONS)).toBe("once")
  })

  it("picks the allow_always option when the user allows always", () => {
    expect(pickPermissionOptionId("allow-always", OPTIONS)).toBe("always")
  })

  it("picks the reject_once option when the user denies", () => {
    expect(pickPermissionOptionId("deny", OPTIONS)).toBe("no")
  })

  it("falls back to allow_once when the agent offers no allow_always option", () => {
    expect(
      pickPermissionOptionId("allow-always", [
        { optionId: "once", name: "Allow", kind: "allow_once" },
      ]),
    ).toBe("once")
  })

  it("falls back to reject_always when the agent offers no reject_once option", () => {
    expect(
      pickPermissionOptionId("deny", [
        { optionId: "never", name: "Never", kind: "reject_always" },
      ]),
    ).toBe("never")
  })

  it("returns undefined when the agent offers no usable option", () => {
    expect(pickPermissionOptionId("deny", [])).toBeUndefined()
  })

  it("returns undefined when the agent offers only options of the opposite polarity", () => {
    expect(
      pickPermissionOptionId("allow", [
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ]),
    ).toBeUndefined()
  })
})
