import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type {
  AttachmentRef,
  AttachmentRefWithBytes,
} from "@spectrum/agent-events"
import { act, renderHook } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useUploads } from "./useUploads"

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "sha_abc",
  mime: "image/png",
  displayName: "shot.png",
  kind: "image",
  bytes: 12,
  ...over,
})

describe("useUploads", () => {
  beforeEach(() => mock.restore())
  afterEach(() => mock.restore())

  it("starts with empty pending + thumbnails", () => {
    const client = createFakeIpcClient({})
    const { result } = renderHook(
      () => useUploads({ image: true, pdf: false, binary: false }, () => {}),
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
      () => useUploads({ image: true, pdf: false, binary: false }, () => {}),
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
      () => useUploads({ image: true, pdf: false, binary: false }, () => {}),
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
      () => useUploads({ image: true, pdf: false, binary: false }, () => {}),
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
      () => useUploads({ image: true, pdf: false, binary: false }, () => {}),
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
      () => useUploads({ image: true, pdf: false, binary: false }, onOpen),
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
})
