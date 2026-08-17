import { describe, expect, it } from "bun:test"
import { ExtensionViewSchema } from "./extension-view"

const view = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  enabled: true,
  source: {
    kind: "git",
    url: "https://e.com/a.git",
    ref: "HEAD",
    commit: "c1",
  },
  unavailable: false,
  ignoredContributions: [] as string[],
  providers: [
    {
      key: "plugin:acme",
      label: "Acme",
      status: "running",
      launchCommand: "/usr/local/bin/acme-server",
      launchArgs: ["--port", "{{port}}"],
      secretFieldNames: ["apiKey"],
    },
  ],
}

describe("ExtensionViewSchema", () => {
  it("accepts a well-formed view", () => {
    expect(ExtensionViewSchema.safeParse(view).success).toBe(true)
  })

  it("accepts a view whose extension contributes nothing", () => {
    expect(
      ExtensionViewSchema.safeParse({ ...view, providers: [] }).success,
    ).toBe(true)
  })

  it("accepts a linked path source", () => {
    expect(
      ExtensionViewSchema.safeParse({
        ...view,
        source: { kind: "path", path: "/src/acme", linked: true },
      }).success,
    ).toBe(true)
  })

  it("accepts a local hand-placed source with no install record", () => {
    expect(
      ExtensionViewSchema.safeParse({
        ...view,
        source: { kind: "local" },
        enabled: false,
      }).success,
    ).toBe(true)
  })

  it("accepts a view marked unavailable when a linked source has vanished", () => {
    expect(
      ExtensionViewSchema.safeParse({
        ...view,
        unavailable: true,
        providers: [],
      }).success,
    ).toBe(true)
  })

  it("rejects a view carrying a secret value", () => {
    expect(
      ExtensionViewSchema.safeParse({ ...view, secrets: { apiKey: "sk-x" } })
        .success,
    ).toBe(false)
  })

  it("rejects a contributed provider carrying a resolved env map", () => {
    expect(
      ExtensionViewSchema.safeParse({
        ...view,
        providers: [{ ...view.providers[0], env: { ACME_KEY: "sk-x" } }],
      }).success,
    ).toBe(false)
  })

  it("rejects a contributed provider whose status is not a lifecycle state", () => {
    expect(
      ExtensionViewSchema.safeParse({
        ...view,
        providers: [{ ...view.providers[0], status: "vibing" }],
      }).success,
    ).toBe(false)
  })
})
