import { describe, expect, it } from "bun:test"
import { PluginIdSchema } from "@spectrum/types"
import { createInMemoryExtensionFileSource } from "./file-source"

const entry = (id: string, raw: unknown = { id, name: id }) => ({ id, raw })
const pid = (id: string) => PluginIdSchema.parse(id)

describe("createInMemoryExtensionFileSource", () => {
  it("lists every entry it was constructed with", async () => {
    const source = createInMemoryExtensionFileSource([entry("a"), entry("b")])
    const listed = await source.listExtensions()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.value.map((e) => (e as { id: string }).id)).toEqual([
        "a",
        "b",
      ])
    }
  })

  it("reads a single extension by id", async () => {
    const source = createInMemoryExtensionFileSource([
      entry("a", { id: "a", name: "Alpha" }),
    ])
    const read = await source.readExtension("a")
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value.raw).toEqual({ id: "a", name: "Alpha" })
  })

  it("fails with not-found when readExtension is given an unknown id", async () => {
    const source = createInMemoryExtensionFileSource([entry("a")])
    const read = await source.readExtension("ghost")
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toEqual({ kind: "not-found", id: "ghost" })
  })

  it("removes an extension by id so it no longer lists", async () => {
    const source = createInMemoryExtensionFileSource([entry("a"), entry("b")])
    const removed = await source.removeExtension("a")
    expect(removed.ok).toBe(true)

    const listed = await source.listExtensions()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.value.map((e) => (e as { id: string }).id)).toEqual(["b"])
    }
  })

  it("treats removing a missing id as success", async () => {
    const source = createInMemoryExtensionFileSource([entry("a")])
    const removed = await source.removeExtension("ghost")
    expect(removed).toEqual({ ok: true, value: undefined })
  })

  it("returns a distinct informational path per id from extensionDir", () => {
    const source = createInMemoryExtensionFileSource([])
    expect(source.extensionDir(pid("a"))).not.toBe(
      source.extensionDir(pid("b")),
    )
  })

  it("returns the preset failure from every method when configured", async () => {
    const failure = { kind: "read-failed", detail: "boom" } as const
    const source = createInMemoryExtensionFileSource([entry("a")], failure)

    const listed = await source.listExtensions()
    expect(listed).toEqual({ ok: false, error: failure })

    const read = await source.readExtension("a")
    expect(read).toEqual({ ok: false, error: failure })

    const removed = await source.removeExtension("a")
    expect(removed).toEqual({ ok: false, error: failure })
  })
})
