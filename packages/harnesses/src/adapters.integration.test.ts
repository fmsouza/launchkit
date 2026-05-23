import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPathCommandResolver, createBunProcessSpawner, createDirHarnessFileSource } from "./adapters"

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lk-harness-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("createPathCommandResolver (real)", () => {
  it("resolves a real on-PATH command to an absolute path", () => {
    const r = createPathCommandResolver().resolve("true")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.startsWith("/")).toBe(true)
  })

  it("rejects a relative command without touching PATH", () => {
    const r = createPathCommandResolver().resolve("./nope")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-command")
  })
})

describe("createBunProcessSpawner (real)", () => {
  it("spawns a harmless command and returns a numeric pid", () => {
    const resolver = createPathCommandResolver()
    const resolved = resolver.resolve("true")
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const r = createBunProcessSpawner().spawn(resolved.value, [], {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(typeof r.value.pid).toBe("number")
  })
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
    const r = await createDirHarnessFileSource(join(makeTempDir(), "missing")).listDefinitions()
    expect(r).toEqual({ ok: true, value: [] })
  })

  it("returns a read-failed error when a file contains invalid JSON", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "broken.json"), "{ not valid json")
    const r = await createDirHarnessFileSource(dir).listDefinitions()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })
})
