import { describe, expect, it } from "bun:test"
import { detectMode } from "./detect-mode"

describe("detectMode", () => {
  it("returns 'cli' when argv contains a known subcommand", () => {
    expect(detectMode(["bun", "main.ts", "launch", "claude"])).toBe("cli")
  })
  it("returns 'gui' when argv has no subcommand", () => {
    expect(detectMode(["bun", "main.ts"])).toBe("gui")
  })
  it("returns 'cli' for each known verb (launch/list/add/remove)", () => {
    for (const verb of ["launch", "list", "add", "remove"]) {
      expect(detectMode(["bun", "main.ts", verb])).toBe("cli")
    }
  })
})
