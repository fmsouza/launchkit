import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessDefinition } from "@spectrum/types"
import { createDirHarnessFileSource } from "./adapters"

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lk-harness-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("createDirHarnessFileSource (real)", () => {
  it("reads and JSON-parses every *.json file in the directory", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a" }))
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "b" }))
    writeFileSync(join(dir, "ignore.txt"), "not json")

    const r = await createDirHarnessFileSource(dir).listDefinitions()
    expect(r.ok).toBe(true)
    if (r.ok) {
      const ids = r.value.map((d) => (d as { id: string }).id).sort()
      expect(ids).toEqual(["a", "b"])
    }
  })

  it("returns ok with an empty list when the directory does not exist", async () => {
    const r = await createDirHarnessFileSource(
      join(makeTempDir(), "missing"),
    ).listDefinitions()
    expect(r).toEqual({ ok: true, value: [] })
  })

  it("returns a read-failed error when a file contains invalid JSON", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "broken.json"), "{ not valid json")
    const r = await createDirHarnessFileSource(dir).listDefinitions()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })

  const definition = (id: string): HarnessDefinition =>
    ({
      id,
      name: `Harness ${id}`,
      command: "claude",
      apiFormat: "anthropic",
      envTemplate: { ANTHROPIC_BASE_URL: "{{baseUrl}}" },
      description: "an integration test harness",
      builtIn: false,
    }) as unknown as HarnessDefinition

  it("writes a harness JSON file and reads it back via listDefinitions, then deletes it", async () => {
    const dir = join(makeTempDir(), `nested-${crypto.randomUUID()}`)
    const source = createDirHarnessFileSource(dir)

    const written = await source.writeDefinition(definition("my-harness"))
    expect(written.ok).toBe(true)

    const listed = await source.listDefinitions()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.value.map((d) => (d as { id: string }).id)).toEqual([
        "my-harness",
      ])
    }
    expect(readdirSync(dir)).toContain("my-harness.json")

    const deleted = await source.deleteDefinition("my-harness")
    expect(deleted.ok).toBe(true)
    const after = await source.listDefinitions()
    expect(after).toEqual({ ok: true, value: [] })
  })

  it("returns an err when writing an invalid definition", async () => {
    const dir = makeTempDir()
    const r = await createDirHarnessFileSource(dir).writeDefinition({
      id: "bad",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-definition")
  })

  it("treats deleting a missing id as success", async () => {
    const dir = makeTempDir()
    const r = await createDirHarnessFileSource(dir).deleteDefinition("ghost")
    expect(r).toEqual({ ok: true, value: undefined })
  })

  it("rejects an id containing path separators or '..'", async () => {
    const dir = makeTempDir()
    const source = createDirHarnessFileSource(dir)

    for (const badId of ["../escape", "a/b", "a\\b", "..", ""]) {
      const write = await source.writeDefinition(definition(badId))
      expect(write.ok).toBe(false)
      const del = await source.deleteDefinition(badId)
      expect(del.ok).toBe(false)
    }

    // Nothing escaped the directory.
    expect(readdirSync(dir)).toEqual([])
  })
})
