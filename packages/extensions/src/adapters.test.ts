import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginIdSchema } from "@spectrum/types"
import { createDirExtensionFileSource } from "./adapters"

/** A validated `PluginId` — `extensionDir` only accepts ids that already passed this. */
const pid = (id: string) => PluginIdSchema.parse(id)

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spectrum-extensions-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const writeManifest = (dir: string, id: string, extra: object = {}): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "spectrum-extension.json"),
    JSON.stringify({
      apiVersion: "spectrum.dev/v1",
      id,
      name: id,
      version: "1.0.0",
      ...extra,
    }),
  )
}

describe("createDirExtensionFileSource (real)", () => {
  it("reads and JSON-parses every extension's manifest under root", async () => {
    const root = makeTempDir()
    writeManifest(join(root, "a"), "a")
    writeManifest(join(root, "b"), "b")

    const r = await createDirExtensionFileSource(root, {}).listExtensions()
    expect(r.ok).toBe(true)
    if (r.ok) {
      const ids = r.value.map((e) => e.id).sort()
      expect(ids).toEqual(["a", "b"])
    }
  })

  it("returns ok with an empty list when root does not exist", async () => {
    const r = await createDirExtensionFileSource(
      join(makeTempDir(), "missing"),
      {},
    ).listExtensions()
    expect(r).toEqual({ ok: true, value: [] })
  })

  it("skips a stray directory with no manifest instead of failing", async () => {
    const root = makeTempDir()
    writeManifest(join(root, "a"), "a")
    mkdirSync(join(root, "stray"), { recursive: true }) // no manifest file inside

    const r = await createDirExtensionFileSource(root, {}).listExtensions()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((e) => e.id)).toEqual(["a"])
  })

  it("yields source-unavailable for a linked extension whose path is gone, and still loads the rest", async () => {
    const root = makeTempDir()
    writeManifest(join(root, "a"), "a")
    const missingLinkPath = join(makeTempDir(), "does-not-exist")

    const r = await createDirExtensionFileSource(root, {
      dead: missingLinkPath,
    }).listExtensions()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toContainEqual({
        id: "a",
        raw: {
          apiVersion: "spectrum.dev/v1",
          id: "a",
          name: "a",
          version: "1.0.0",
        },
      })
      const deadEntry = r.value.find((e) => e.id === "dead")
      expect(deadEntry).toEqual({
        id: "dead",
        error: {
          kind: "source-unavailable",
          id: "dead",
          path: missingLinkPath,
        },
      })
    }
  })

  it("reads a linked extension from its live source directory, not root/id", async () => {
    const root = makeTempDir()
    const linkedDir = makeTempDir()
    writeManifest(linkedDir, "linked", { name: "Linked Ext" })

    const source = createDirExtensionFileSource(root, { linked: linkedDir })
    const listed = await source.listExtensions()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      const found = listed.value.find((e) => e.id === "linked")
      expect(found).toEqual({
        id: "linked",
        raw: {
          apiVersion: "spectrum.dev/v1",
          id: "linked",
          name: "Linked Ext",
          version: "1.0.0",
        },
      })
    }
    expect(source.extensionDir(pid("linked"))).toBe(linkedDir)
  })

  it("reads a single extension by id via readExtension", async () => {
    const root = makeTempDir()
    writeManifest(join(root, "a"), "a", { name: "Alpha" })

    const r = await createDirExtensionFileSource(root, {}).readExtension("a")
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value.raw as { name: string }).name).toBe("Alpha")
  })

  it("fails with not-found when readExtension targets a missing extension", async () => {
    const root = makeTempDir()
    const r = await createDirExtensionFileSource(root, {}).readExtension(
      "ghost",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toEqual({ kind: "not-found", id: "ghost" })
  })

  it("fails with source-unavailable when readExtension targets a dead link", async () => {
    const missingLinkPath = join(makeTempDir(), "does-not-exist")
    const r = await createDirExtensionFileSource(makeTempDir(), {
      dead: missingLinkPath,
    }).readExtension("dead")
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toEqual({
        kind: "source-unavailable",
        id: "dead",
        path: missingLinkPath,
      })
  })

  it("removes an owned extension directory by id", async () => {
    const root = makeTempDir()
    writeManifest(join(root, "a"), "a")

    const source = createDirExtensionFileSource(root, {})
    const removed = await source.removeExtension("a")
    expect(removed.ok).toBe(true)

    const after = await source.listExtensions()
    expect(after).toEqual({ ok: true, value: [] })
  })

  it("leaves a linked extension's source directory untouched when removed", async () => {
    const root = makeTempDir()
    const linkedDir = makeTempDir()
    writeManifest(linkedDir, "linked")

    const source = createDirExtensionFileSource(root, { linked: linkedDir })
    const removed = await source.removeExtension("linked")
    expect(removed.ok).toBe(true)

    // The external, caller-owned directory the link points at must survive — removeExtension
    // only ever deletes root-owned copies, never a linked source.
    expect(existsSync(linkedDir)).toBe(true)
    expect(existsSync(join(linkedDir, "spectrum-extension.json"))).toBe(true)
  })

  it("treats removing a missing extension as success", async () => {
    const root = makeTempDir()
    const r = await createDirExtensionFileSource(root, {}).removeExtension(
      "ghost",
    )
    expect(r).toEqual({ ok: true, value: undefined })
  })

  it("resolves extensionDir to root/id for an unlinked extension", async () => {
    const root = makeTempDir()
    const source = createDirExtensionFileSource(root, {})
    expect(source.extensionDir(pid("a"))).toBe(join(root, "a"))
  })

  it("makes a path-traversal id unrepresentable as the PluginId extensionDir requires", () => {
    // extensionDir(id: PluginId) has no Result to reject through, so the guard has to be
    // that a traversal string can never become a PluginId in the first place — proven here
    // by showing PluginIdSchema itself refuses every form safeId also rejects.
    for (const badId of ["../escape", "a/b", "a\\b", "..", ""]) {
      expect(PluginIdSchema.safeParse(badId).success).toBe(false)
    }
  })

  for (const badId of ["../escape", "a/b", "a\\b", ".."]) {
    it(`rejects the id "${badId}" before joining any path (readExtension)`, async () => {
      const root = makeTempDir()
      const r = await createDirExtensionFileSource(root, {}).readExtension(
        badId,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("read-failed")
    })
  }

  it("rejects an unsafe id before joining any path in listExtensions' linkMap resolution", async () => {
    const root = makeTempDir()
    const r = await createDirExtensionFileSource(root, {
      "../escape": "/tmp/whatever",
    }).listExtensions()
    // The unsafe linkMap key must not reach a path join; the batch fails loudly instead
    // of silently reading or writing outside root.
    expect(r.ok).toBe(false)
  })

  it("rejects an unsafe id before joining any path (removeExtension)", async () => {
    const root = makeTempDir()
    const r = await createDirExtensionFileSource(root, {}).removeExtension(
      "a/../../escape",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })
})
