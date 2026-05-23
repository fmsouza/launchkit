import { describe, it, expect } from "bun:test"
import * as types from "./index"

describe("@launchkit/types barrel", () => {
  it("exports every schema and enum when imported", () => {
    for (const name of [
      "SdkProviderSchema","ApiFormatSchema","ProviderIdSchema","AliasNameSchema",
      "HarnessIdSchema","SessionIdSchema","SecretRefSchema","ProviderSchema",
      "ModelAliasSchema","HarnessDefinitionSchema","SessionSchema",
    ]) {
      expect(types).toHaveProperty(name)
    }
  })
})
