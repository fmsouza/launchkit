import { describe, expect, it } from "bun:test"
import { HarnessIdSchema } from "@launchkit/types"
import { builtinHarnesses } from "./builtin/index"
import { createInMemoryHarnessFileSource } from "./file-source"
import { createRegistry } from "./registry"

const validUserDef = {
  id: "my-tool",
  name: "My Tool",
  command: "my-tool",
  apiFormat: "openai",
  envTemplate: {
    OPENAI_BASE_URL: "{{proxyUrl}}",
    OPENAI_API_KEY: "{{proxyKey}}",
    OPENAI_MODEL: "{{model}}",
  },
  defaultAlias: "default",
  builtIn: true, // registry must force this to false; a sneaky true is overridden
}

describe("createRegistry", () => {
  it("returns the built-ins alone when there are no user definitions", async () => {
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([]),
    })
    const r = await registry.list()
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.map((h) => h.id)).toEqual(
        builtinHarnesses.map((h) => h.id),
      )
  })

  it("appends valid user definitions after the built-ins", async () => {
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([validUserDef]),
    })
    const r = await registry.list()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((h) => h.id)).toEqual([
        ...builtinHarnesses.map((h) => h.id),
        HarnessIdSchema.parse("my-tool"),
      ])
    }
  })

  it("forces builtIn:false on every user definition", async () => {
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([validUserDef]),
    })
    const r = await registry.list()
    expect(r.ok).toBe(true)
    if (r.ok) {
      const mine = r.value.find((h) => h.id === "my-tool")
      expect(mine?.builtIn).toBe(false)
    }
  })

  it("returns a duplicate-id error when a user definition reuses a built-in id", async () => {
    const collide = { ...validUserDef, id: "claude" }
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([collide]),
    })
    const r = await registry.list()
    expect(r).toEqual({
      ok: false,
      error: { kind: "duplicate-id", id: "claude" },
    })
  })

  it("returns an invalid-definition error when a user definition fails the schema", async () => {
    const broken = { id: "", name: "", command: "" } // missing required fields, empty id
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([broken]),
    })
    const r = await registry.list()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-definition")
  })

  it("returns an invalid-template error when a user definition uses an unknown token", async () => {
    const badEnv = {
      ...validUserDef,
      id: "leaky",
      envTemplate: { K: "{{secret}}" },
    }
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([badEnv]),
    })
    const r = await registry.list()
    expect(r).toEqual({
      ok: false,
      error: { kind: "invalid-template", token: "secret" },
    })
  })

  it("propagates a read-failed error from the file source", async () => {
    const failing = createInMemoryHarnessFileSource([], {
      kind: "read-failed",
      detail: "EACCES",
    })
    const registry = createRegistry({ fileSource: failing })
    const r = await registry.list()
    expect(r).toEqual({
      ok: false,
      error: { kind: "read-failed", detail: "EACCES" },
    })
  })
})
