import { describe, it, expect } from "bun:test"
import * as ui from "./index"

describe("@launchkit/ui barrel", () => {
  it("exports every public component when imported", () => {
    for (const name of [
      "Button", "TextInput", "Select", "Badge", "StatusDot", "Spinner", "Label",
      "FormField", "ProviderCard", "AliasRow", "EmptyState",
      "ProviderList", "AliasTable", "HarnessForm", "SessionTable",
      "AppShell", "SettingsLayout",
    ]) {
      expect(ui).toHaveProperty(name)
    }
  })
})
