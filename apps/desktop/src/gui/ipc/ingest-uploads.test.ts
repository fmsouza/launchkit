import { describe, expect, it } from "bun:test"
import type { AttachmentRef } from "@spectrum/agent-events"
import { MAX_UPLOAD_BYTES } from "@spectrum/agent-events"
import { createNoopLogger } from "@spectrum/logger"
import type { UploadStore } from "@spectrum/runtime-core"
import { type UploadSource, ingestUploads, mimeFromExt } from "./ingest-uploads"

const log = createNoopLogger()

const refFor = (displayName: string, mime: string): AttachmentRef => ({
  id: `sha_${displayName}`,
  mime,
  displayName,
  kind: mime.startsWith("image/") ? "image" : "binary",
  bytes: 3,
})

/** Recording fake store; per-method overrides for failure cases. */
const fakeStore = (
  over: Partial<UploadStore> = {},
): UploadStore & {
  saveCalls: Array<{ sourcePath: string; mime: string; maxBytes: number }>
  saveBytesCalls: Array<{ displayName: string; mime: string; maxBytes: number }>
} => {
  const saveCalls: Array<{
    sourcePath: string
    mime: string
    maxBytes: number
  }> = []
  const saveBytesCalls: Array<{
    displayName: string
    mime: string
    maxBytes: number
  }> = []
  return {
    saveCalls,
    saveBytesCalls,
    save: async ({ sourcePath, mime, displayName, maxBytes }) => {
      saveCalls.push({ sourcePath, mime, maxBytes })
      return {
        ok: true,
        value: { ref: refFor(displayName, mime), path: `/up/${displayName}` },
      }
    },
    saveBytes: async ({ displayName, mime, maxBytes }) => {
      saveBytesCalls.push({ displayName, mime, maxBytes })
      return {
        ok: true,
        value: { ref: refFor(displayName, mime), path: `/up/${displayName}` },
      }
    },
    readBase64: async () => ({
      ok: false,
      error: { kind: "not-found", detail: "stub" },
    }),
    pathOf: async () => ({
      ok: false,
      error: { kind: "not-found", detail: "stub" },
    }),
    exists: async () => false,
    size: async () => 0,
    ...over,
  }
}

const pathSource = (path: string): UploadSource => ({ kind: "path", path })

describe("mimeFromExt", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(mimeFromExt("a.png")).toBe("image/png")
    expect(mimeFromExt("doc.pdf")).toBe("application/pdf")
    expect(mimeFromExt("no-extension")).toBe("application/octet-stream")
  })
})

describe("ingestUploads", () => {
  it("saves path sources via store.save with the extension-inferred mime and the shared cap", async () => {
    const store = fakeStore()
    const res = await ingestUploads({
      sources: [pathSource("/tmp/a.png")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(res.uploads.map((u) => u.displayName)).toEqual(["a.png"])
    expect(store.saveCalls).toEqual([
      {
        sourcePath: "/tmp/a.png",
        mime: "image/png",
        maxBytes: MAX_UPLOAD_BYTES,
      },
    ])
  })

  it("saves bytes sources via store.saveBytes using the provided mime when non-empty", async () => {
    const store = fakeStore()
    const res = await ingestUploads({
      sources: [
        {
          kind: "bytes",
          displayName: "shot.png",
          mime: "image/png",
          data: new Uint8Array(3),
        },
      ],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(res.uploads).toHaveLength(1)
    expect(store.saveBytesCalls).toEqual([
      {
        displayName: "shot.png",
        mime: "image/png",
        maxBytes: MAX_UPLOAD_BYTES,
      },
    ])
  })

  it("infers the mime from the extension when a bytes source has no usable mime", async () => {
    const store = fakeStore()
    await ingestUploads({
      sources: [
        { kind: "bytes", displayName: "shot.png", data: new Uint8Array(3) },
      ],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(store.saveBytesCalls[0]?.mime).toBe("image/png")
  })

  it("rejects sources whose kind is not accepted without touching the store", async () => {
    const store = fakeStore()
    const res = await ingestUploads({
      sources: [pathSource("/tmp/doc.pdf")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(res.uploads).toEqual([])
    expect(res.rejected).toEqual([
      { displayName: "doc.pdf", reason: "unsupported-kind" },
    ])
    expect(store.saveCalls).toEqual([])
  })

  it("isolates per-file failures: one failing save does not block the others", async () => {
    const store = fakeStore({
      save: async ({ sourcePath, mime }) => {
        const displayName = sourcePath.split("/").pop() ?? sourcePath
        if (displayName === "broken.png") {
          return { ok: false, error: { kind: "io-failed", detail: "disk" } }
        }
        if (displayName === "big.png") {
          return { ok: false, error: { kind: "too-large", detail: "11 > 10" } }
        }
        return {
          ok: true,
          value: { ref: refFor(displayName, mime), path: `/up/${displayName}` },
        }
      },
    })
    const res = await ingestUploads({
      sources: [
        pathSource("/tmp/ok.png"),
        pathSource("/tmp/broken.png"),
        pathSource("/tmp/big.png"),
      ],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(res.uploads.map((u) => u.displayName)).toEqual(["ok.png"])
    expect(res.errors).toEqual([
      { displayName: "broken.png", reason: "io-failed" },
      { displayName: "big.png", reason: "too-large" },
    ])
  })

  it("preserves input order in uploads even when saves resolve out of order", async () => {
    const gates = new Map<string, () => void>()
    const store = fakeStore({
      save: async ({ sourcePath, mime }) => {
        const displayName = sourcePath.split("/").pop() ?? sourcePath
        await new Promise<void>((resolve) => gates.set(displayName, resolve))
        return {
          ok: true,
          value: { ref: refFor(displayName, mime), path: `/up/${displayName}` },
        }
      },
    })
    const p = ingestUploads({
      sources: [pathSource("/tmp/first.png"), pathSource("/tmp/second.png")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    // Release in REVERSE order — result order must still follow the input.
    await new Promise((r) => setTimeout(r, 0))
    gates.get("second.png")?.()
    gates.get("first.png")?.()
    const res = await p
    expect(res.uploads.map((u) => u.displayName)).toEqual([
      "first.png",
      "second.png",
    ])
  })

  it("processes sources concurrently (second save starts before the first resolves)", async () => {
    const started: string[] = []
    let releaseFirst: (() => void) | undefined
    const store = fakeStore({
      save: async ({ sourcePath, mime }) => {
        const displayName = sourcePath.split("/").pop() ?? sourcePath
        started.push(displayName)
        if (displayName === "a.png") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return {
          ok: true,
          value: { ref: refFor(displayName, mime), path: `/up/${displayName}` },
        }
      },
    })
    const p = ingestUploads({
      sources: [pathSource("/tmp/a.png"), pathSource("/tmp/b.png")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    await new Promise((r) => setTimeout(r, 0))
    // Sequential processing would still be awaiting a.png here.
    expect(started).toEqual(["a.png", "b.png"])
    releaseFirst?.()
    await p
  })

  it("produces identical refs for the same logical file via path and bytes sources (parity)", async () => {
    const store = fakeStore()
    const viaPath = await ingestUploads({
      sources: [pathSource("/tmp/shot.png")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    const viaBytes = await ingestUploads({
      sources: [
        { kind: "bytes", displayName: "shot.png", data: new Uint8Array(3) },
      ],
      acceptedKinds: ["image"],
      store,
      log,
    })
    // Same displayName + same inferred mime → the store mints the same ref
    // either way; the entry method must be invisible in the result.
    expect(viaBytes.uploads).toEqual(viaPath.uploads)
    expect(store.saveCalls[0]?.mime).toBe(store.saveBytesCalls[0]?.mime)
  })

  it("omits rejected/errors fields entirely when every source is accepted", async () => {
    const store = fakeStore()
    const res = await ingestUploads({
      sources: [pathSource("/tmp/a.png")],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect("rejected" in res).toBe(false)
    expect("errors" in res).toBe(false)
  })

  it("derives the display name from the last segment of a Windows path", async () => {
    const store = fakeStore()
    const res = await ingestUploads({
      sources: [{ kind: "path", path: "C:\\Users\\fred\\Pictures\\shot.png" }],
      acceptedKinds: ["image"],
      store,
      log,
    })
    expect(res.uploads.map((u) => u.displayName)).toEqual(["shot.png"])
  })
})
