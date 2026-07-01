import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFsUploadStore } from "./upload-store-fs"

describe("createFsUploadStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spectrum-uploads-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("save copies the file into uploadsDir with a sha256 id and returns a ref", async () => {
    const src = join(dir, "src.png")
    writeFileSync(src, Buffer.from("hello"))
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const res = await store.save({
      sourcePath: src,
      mime: "image/png",
      displayName: "photo.png",
      maxBytes: 10 * 1024 * 1024,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const { ref, path } = res.value
      expect(ref.kind).toBe("image")
      expect(ref.displayName).toBe("photo.png")
      expect(ref.id).toHaveLength(64) // sha256 hex
      expect(path).toContain(join(dir, "up"))
    }
  })

  it("save is idempotent for identical content (same id)", async () => {
    const src = join(dir, "src.txt")
    writeFileSync(src, "same")
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const a = await store.save({
      sourcePath: src,
      mime: "text/plain",
      displayName: "a.txt",
      maxBytes: 1e7,
    })
    const src2 = join(dir, "src2.txt")
    writeFileSync(src2, "same")
    const b = await store.save({
      sourcePath: src2,
      mime: "text/plain",
      displayName: "b.txt",
      maxBytes: 1e7,
    })
    if (!a.ok) throw new Error("save a failed")
    if (!b.ok) throw new Error("save b failed")
    expect(a.value.ref.id).toBe(b.value.ref.id)
  })

  it("save rejects too-large files", async () => {
    const src = join(dir, "big.bin")
    writeFileSync(src, Buffer.alloc(100))
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const res = await store.save({
      sourcePath: src,
      mime: "application/octet-stream",
      displayName: "big.bin",
      maxBytes: 10,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("too-large")
  })

  it("readBase64 returns the base64 contents for an existing id", async () => {
    const src = join(dir, "x.png")
    writeFileSync(src, Buffer.from("hello"))
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const saved = await store.save({
      sourcePath: src,
      mime: "image/png",
      displayName: "x.png",
      maxBytes: 1e7,
    })
    if (!saved.ok) throw new Error("save failed")
    const r = await store.readBase64(saved.value.ref.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Buffer.from(r.value, "base64").toString()).toBe("hello")
  })

  it("readBase64 is not-found for a missing id", async () => {
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const r = await store.readBase64("nonexistent")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-found")
  })

  it("exists returns false for a missing id", async () => {
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    expect(await store.exists("nope")).toBe(false)
  })

  it("saveBytes stores content under the same sha256 id and path as save", async () => {
    const src = join(dir, "src.png")
    writeFileSync(src, Buffer.from("same-bytes"))
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const viaPath = await store.save({
      sourcePath: src,
      mime: "image/png",
      displayName: "photo.png",
      maxBytes: 1e7,
    })
    const viaBytes = await store.saveBytes({
      data: new Uint8Array(Buffer.from("same-bytes")),
      mime: "image/png",
      displayName: "photo.png",
      maxBytes: 1e7,
    })
    expect(viaPath.ok).toBe(true)
    expect(viaBytes.ok).toBe(true)
    if (viaPath.ok && viaBytes.ok) {
      expect(viaBytes.value.ref.id).toBe(viaPath.value.ref.id)
      expect(viaBytes.value.path).toBe(viaPath.value.path)
      expect(viaBytes.value.ref.kind).toBe("image")
      expect(viaBytes.value.ref.bytes).toBe(10)
    }
  })

  it("saveBytes rejects content larger than maxBytes with too-large", async () => {
    const store = createFsUploadStore({ uploadsDir: join(dir, "up") })
    const res = await store.saveBytes({
      data: new Uint8Array(11),
      mime: "image/png",
      displayName: "big.png",
      maxBytes: 10,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("too-large")
  })
})
