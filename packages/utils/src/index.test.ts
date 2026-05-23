import { describe, expect, it } from "bun:test"
import * as utils from "./index"

describe("@launchkit/utils barrel", () => {
  it("exports every public symbol when imported", () => {
    for (const name of [
      "ok",
      "err",
      "isOk",
      "isErr",
      "map",
      "mapErr",
      "andThen",
      "unwrapOr",
      "pipe",
      "flow",
      "renderTemplate",
      "redactSecrets",
      "createSystemClock",
      "createFixedClock",
      "createCryptoIdGen",
      "createSequentialIdGen",
    ]) {
      expect(utils).toHaveProperty(name)
    }
  })
})
