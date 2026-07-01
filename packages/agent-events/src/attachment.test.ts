import { describe, expect, it } from "bun:test"
import {
  AttachmentCapabilitiesSchema,
  AttachmentRefSchema,
  AttachmentRefWithBytesSchema,
  MAX_UPLOAD_BYTES,
  acceptedMimesFromCapabilities,
  inferKind,
  stripDataUrl,
} from "./attachment"

describe("attachment domain", () => {
  it("inferKind returns image for image/* mime", () => {
    expect(inferKind("image/png", "photo.png")).toBe("image")
    expect(inferKind("image/jpeg", "photo.jpg")).toBe("image")
  })

  it("inferKind returns pdf for application/pdf", () => {
    expect(inferKind("application/pdf", "doc.pdf")).toBe("pdf")
  })

  it("inferKind returns text for text/* mime", () => {
    expect(inferKind("text/plain", "notes.txt")).toBe("text")
  })

  it("inferKind returns text for known code extension even with octet-stream mime", () => {
    expect(inferKind("application/octet-stream", "app.ts")).toBe("text")
    expect(inferKind("application/octet-stream", "config.json")).toBe("text")
    expect(inferKind("application/octet-stream", "README.md")).toBe("text")
  })

  it("inferKind returns binary for unknown extension + octet-stream", () => {
    expect(inferKind("application/octet-stream", "blob.dat")).toBe("binary")
  })

  it("acceptedMimesFromCapabilities lists image mimes when image enabled", () => {
    expect(
      acceptedMimesFromCapabilities({ image: true, pdf: false, binary: false }),
    ).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"])
  })

  it("acceptedMimesFromCapabilities includes application/pdf when pdf enabled", () => {
    expect(
      acceptedMimesFromCapabilities({ image: false, pdf: true, binary: false }),
    ).toEqual(["application/pdf"])
  })

  it("acceptedMimesFromCapabilities uses */* when only binary enabled", () => {
    expect(
      acceptedMimesFromCapabilities({ image: false, pdf: false, binary: true }),
    ).toEqual(["*/*"])
  })

  it("acceptedMimesFromCapabilities combines all enabled kinds", () => {
    const mimes = acceptedMimesFromCapabilities({
      image: true,
      pdf: true,
      binary: true,
    })
    expect(mimes).toContain("image/png")
    expect(mimes).toContain("application/pdf")
    expect(mimes).toContain("*/*")
  })

  it("acceptedMimesFromCapabilities returns empty when nothing enabled", () => {
    expect(
      acceptedMimesFromCapabilities({
        image: false,
        pdf: false,
        binary: false,
      }),
    ).toEqual([])
  })

  it("stripDataUrl removes dataUrl leaving the ref", () => {
    const ref = stripDataUrl({
      id: "abc",
      mime: "image/png",
      displayName: "p.png",
      kind: "image",
      bytes: 10,
      dataUrl: "data:image/png;base64,AAAA",
    })
    expect(ref).toEqual({
      id: "abc",
      mime: "image/png",
      displayName: "p.png",
      kind: "image",
      bytes: 10,
    })
  })

  it("AttachmentRefSchema parses a valid ref", () => {
    const parsed = AttachmentRefSchema.safeParse({
      id: "abc",
      mime: "image/png",
      displayName: "p.png",
      kind: "image",
      bytes: 10,
    })
    expect(parsed.success).toBe(true)
  })

  it("AttachmentRefSchema rejects an unknown kind", () => {
    const parsed = AttachmentRefSchema.safeParse({
      id: "abc",
      mime: "image/png",
      displayName: "p.png",
      kind: "audio",
      bytes: 10,
    })
    expect(parsed.success).toBe(false)
  })

  it("AttachmentRefWithBytesSchema requires dataUrl", () => {
    expect(
      AttachmentRefWithBytesSchema.safeParse({
        id: "abc",
        mime: "image/png",
        displayName: "p.png",
        kind: "image",
        bytes: 10,
        dataUrl: "data:image/png;base64,AAAA",
      }).success,
    ).toBe(true)
    expect(
      AttachmentRefWithBytesSchema.safeParse({
        id: "abc",
        mime: "image/png",
        displayName: "p.png",
        kind: "image",
        bytes: 10,
      }).success,
    ).toBe(false)
  })

  it("AttachmentCapabilitiesSchema parses a full capability object", () => {
    expect(
      AttachmentCapabilitiesSchema.safeParse({
        image: true,
        pdf: true,
        binary: false,
      }).success,
    ).toBe(true)
  })
})

describe("MAX_UPLOAD_BYTES", () => {
  it("pins the shared per-file upload cap at 10MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
  })
})
