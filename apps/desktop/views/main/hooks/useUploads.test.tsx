import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type {
  AttachmentRef,
  AttachmentRefWithBytes,
} from "@spectrum/agent-events"
import { MAX_UPLOAD_BYTES } from "@spectrum/agent-events"
import { act, renderHook } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { base64FromDataUrl, useUploads } from "./useUploads"

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "sha_abc",
  mime: "image/png",
  displayName: "shot.png",
  kind: "image",
  bytes: 12,
  ...over,
})

const noopNotify = (): void => {}

describe("useUploads", () => {
  beforeEach(() => mock.restore())
  afterEach(() => mock.restore())

  it("starts with empty pending + thumbnails", () => {
    const client = createFakeIpcClient({})
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    expect(result.current.pending).toEqual([])
    expect(result.current.thumbnails.size).toBe(0)
  })

  it("pick appends uploads to pending and resolves image thumbnails", async () => {
    const ref1: AttachmentRef = ref({ id: "sha1" })
    const ref2: AttachmentRef = ref({ id: "sha2", displayName: "two.png" })
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: { uploads: [ref1, ref2], rejected: [] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    expect(result.current.pending).toEqual([ref1, ref2])
    expect(result.current.thumbnails.get("sha1")).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(result.current.thumbnails.get("sha2")).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(client.calls.pickUploads).toHaveLength(1)
    // acceptedMimes should include the image types; acceptedKinds should include "image"
    const call = client.calls.pickUploads[0] as {
      acceptedMimes: string[]
      acceptedKinds: string[]
    }
    expect(call.acceptedMimes).toContain("image/png")
    expect(call.acceptedKinds).toContain("image")
  })

  it("remove drops the ref from pending and its thumbnail", async () => {
    const ref1: AttachmentRef = ref({ id: "sha1" })
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: { uploads: [ref1], rejected: [] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    expect(result.current.pending).toHaveLength(1)
    act(() => {
      result.current.remove("sha1")
    })
    expect(result.current.pending).toEqual([])
    expect(result.current.thumbnails.has("sha1")).toBe(false)
  })

  it("clear empties pending + thumbnails", async () => {
    const ref1: AttachmentRef = ref({ id: "sha1" })
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: { uploads: [ref1], rejected: [] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    act(() => {
      result.current.clear()
    })
    expect(result.current.pending).toEqual([])
    expect(result.current.thumbnails.size).toBe(0)
  })

  it("resolveForSend returns refs with dataUrl for each pending ref", async () => {
    const ref1: AttachmentRef = ref({ id: "sha1", mime: "image/png" })
    const ref2: AttachmentRef = ref({
      id: "sha2",
      mime: "image/jpeg",
      displayName: "two.jpg",
    })
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: { uploads: [ref1, ref2], rejected: [] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
      readUploadDataUrl: async (p: unknown) => {
        const params = p as { id: string; mime: string }
        return {
          ok: true,
          value: {
            dataUrl: `data:${params.mime};base64,bytes-of-${params.id}`,
          },
        }
      },
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    let resolved: AttachmentRefWithBytes[] = []
    await act(async () => {
      resolved = await result.current.resolveForSend()
    })
    expect(resolved).toHaveLength(2)
    expect(resolved[0]?.id).toBe("sha1")
    expect(resolved[0]?.dataUrl).toBe("data:image/png;base64,bytes-of-sha1")
    expect(resolved[1]?.id).toBe("sha2")
    expect(resolved[1]?.dataUrl).toBe("data:image/jpeg;base64,bytes-of-sha2")
    expect(client.calls.readUploadDataUrl).toHaveLength(2)
  })

  it("open delegates to the page-level resolver", () => {
    let seen: { id: string } | null = null
    const onOpen = (r: AttachmentRef, _d: string | null): void => {
      seen = { id: r.id }
    }
    const client = createFakeIpcClient({})
    const r: AttachmentRef = ref({ id: "sha_abc" })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          onOpen,
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    act(() => {
      result.current.open(r)
    })
    expect(seen).toEqual({ id: "sha_abc" })
  })

  it("emits a warning toast for each rejected entry from pickUploads", async () => {
    const ref1: AttachmentRef = ref({ id: "sha1" })
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: {
          uploads: [ref1],
          rejected: [{ displayName: "doc.pdf", reason: "unsupported-kind" }],
        },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const notify = (input: { tone: string; message: string }): void => {
      toasts.push(input)
    }
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          notify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    // The accepted image is still staged, AND the user is told about the reject.
    expect(result.current.pending).toEqual([ref1])
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't attach doc.pdf" },
    ])
  })

  it("emits a warning toast for each IO error returned in the errors field", async () => {
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: true,
        value: {
          uploads: [],
          errors: [
            { displayName: "big.bin", reason: "too-large" },
            { displayName: "broken.png", reason: "io-failed" },
          ],
        },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const notify = (input: { tone: string; message: string }): void => {
      toasts.push(input)
    }
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          notify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    expect(result.current.pending).toEqual([])
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't attach big.bin (too large)" },
      { tone: "warning", message: "Couldn't read broken.png" },
    ])
  })

  it("emits a warning toast when the IPC call itself fails", async () => {
    const client = createFakeIpcClient({
      pickUploads: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "boom" },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const notify = (input: { tone: string; message: string }): void => {
      toasts.push(input)
    }
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          notify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    expect(result.current.pending).toEqual([])
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't open the file picker" },
    ])
  })

  it("strips the data-url prefix with base64FromDataUrl", () => {
    expect(base64FromDataUrl("data:image/png;base64,aGVsbG8=")).toBe("aGVsbG8=")
    expect(base64FromDataUrl("aGVsbG8=")).toBe("aGVsbG8=")
  })

  it("addFiles stages dropped files through saveDroppedUploads and fetches thumbnails", async () => {
    const staged: AttachmentRef = ref({ id: "sha_drop", displayName: "a.png" })
    const client = createFakeIpcClient({
      saveDroppedUploads: async () => ({
        ok: true,
        value: { uploads: [staged] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.addFiles([
        new File(["hello"], "a.png", { type: "image/png" }),
      ])
    })
    expect(result.current.pending).toEqual([staged])
    expect(result.current.thumbnails.get("sha_drop")).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(client.calls.saveDroppedUploads).toHaveLength(1)
    const call = client.calls.saveDroppedUploads[0] as {
      files: Array<{ displayName: string; mime: string; dataBase64: string }>
      acceptedKinds: string[]
    }
    expect(call.acceptedKinds).toContain("image")
    expect(call.files).toEqual([
      { displayName: "a.png", mime: "image/png", dataBase64: btoa("hello") },
    ])
  })

  it("pre-rejects oversize dropped files client-side without shipping their bytes", async () => {
    const staged: AttachmentRef = ref({
      id: "sha_ok",
      displayName: "small.png",
    })
    const client = createFakeIpcClient({
      saveDroppedUploads: async () => ({
        ok: true,
        value: { uploads: [staged] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          (input) => toasts.push(input),
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.png", {
      type: "image/png",
    })
    await act(async () => {
      await result.current.addFiles([
        big,
        new File(["ok"], "small.png", { type: "image/png" }),
      ])
    })
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't attach big.png (too large)" },
    ])
    const call = client.calls.saveDroppedUploads[0] as {
      files: Array<{ displayName: string }>
    }
    expect(call.files.map((f) => f.displayName)).toEqual(["small.png"])
  })

  it("toasts Couldn't read for unreadable dropped entries (e.g. folders) and skips the IPC when nothing survives", async () => {
    const client = createFakeIpcClient({})
    const toasts: Array<{ tone: string; message: string }> = []
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          (input) => toasts.push(input),
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    // A dropped directory arrives as a File-shaped object whose bytes cannot
    // be read — FileReader throws on it, which is exactly the signal we use.
    const folder = { name: "folder", type: "", size: 1 } as unknown as File
    await act(async () => {
      await result.current.addFiles([folder])
    })
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't read folder" },
    ])
    expect(client.calls.saveDroppedUploads).toHaveLength(0)
  })

  it("addFiles is a no-op when the model reports no attachment capabilities", async () => {
    const client = createFakeIpcClient({})
    const { result } = renderHook(
      () => useUploads(undefined, () => {}, noopNotify),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.addFiles([
        new File(["x"], "a.png", { type: "image/png" }),
      ])
    })
    expect(client.calls.saveDroppedUploads).toHaveLength(0)
    expect(result.current.pending).toEqual([])
  })

  it("emits one warning toast when the whole saveDroppedUploads call fails", async () => {
    const client = createFakeIpcClient({
      saveDroppedUploads: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "boom" },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          (input) => toasts.push(input),
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.addFiles([
        new File(["x"], "a.png", { type: "image/png" }),
      ])
    })
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't attach files" },
    ])
    expect(result.current.pending).toEqual([])
  })

  it("toasts drop rejections and errors with the same messages as the picker", async () => {
    const client = createFakeIpcClient({
      saveDroppedUploads: async () => ({
        ok: true,
        value: {
          uploads: [],
          rejected: [{ displayName: "doc.pdf", reason: "unsupported-kind" }],
          errors: [{ displayName: "big.bin", reason: "too-large" }],
        },
      }),
    })
    const toasts: Array<{ tone: string; message: string }> = []
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          (input) => toasts.push(input),
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.addFiles([
        new File(["x"], "doc.pdf", { type: "application/pdf" }),
      ])
    })
    expect(toasts).toEqual([
      { tone: "warning", message: "Couldn't attach doc.pdf" },
      { tone: "warning", message: "Couldn't attach big.bin (too large)" },
    ])
  })

  it("does not stage the same upload id twice (dedupe across picker and drop)", async () => {
    const same: AttachmentRef = ref({ id: "sha_same" })
    const client = createFakeIpcClient({
      pickUploads: async () => ({ ok: true, value: { uploads: [same] } }),
      saveDroppedUploads: async () => ({
        ok: true,
        value: { uploads: [same] },
      }),
      readUploadThumbnail: async () => ({
        ok: true,
        value: { dataUrl: "data:image/png;base64,AAAA" },
      }),
    })
    const { result } = renderHook(
      () =>
        useUploads(
          { image: true, pdf: false, binary: false },
          () => {},
          noopNotify,
        ),
      {
        wrapper: ({ children }) => (
          <IpcClientProvider client={client}>{children}</IpcClientProvider>
        ),
      },
    )
    await act(async () => {
      await result.current.pick()
    })
    await act(async () => {
      await result.current.addFiles([
        new File(["x"], "shot.png", { type: "image/png" }),
      ])
    })
    expect(result.current.pending).toEqual([same])
  })
})
