import { describe, expect, it } from "bun:test"
import { ExtensionManifestSchema, parseManifest } from "./manifest"

const valid = {
  apiVersion: "spectrum.dev/v1",
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  contributes: { providers: [] },
}

const contribution = (id: string): unknown => ({
  id,
  descriptor: {
    label: `Acme ${id}`,
    reasoning: { shape: "none", supportedTiers: [] },
    discovery: { strategy: "openai-models" },
  },
  transport: { kind: "http", wire: "openai" },
})

describe("ExtensionManifestSchema", () => {
  it("accepts a manifest declaring a supported api version", () => {
    expect(ExtensionManifestSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects a manifest whose root carries an unknown key", () => {
    expect(
      ExtensionManifestSchema.safeParse({ ...valid, extra: 1 }).success,
    ).toBe(false)
  })

  it("rejects a manifest whose id is not a lowercase slug", () => {
    expect(
      ExtensionManifestSchema.safeParse({ ...valid, id: "Acme" }).success,
    ).toBe(false)
  })

  it("accepts a manifest contributing nothing at all", () => {
    const parsed = ExtensionManifestSchema.safeParse({
      ...valid,
      contributes: {},
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a manifest whose own contributions collide on id", () => {
    const parsed = ExtensionManifestSchema.safeParse({
      ...valid,
      contributes: { providers: [contribution("dup"), contribution("dup")] },
    })
    expect(parsed.success).toBe(false)
  })

  it("reports exactly one issue when many contributions collide, not one per duplicate", () => {
    const providers = Array.from({ length: 200 }, () => contribution("dup"))
    const parsed = ExtensionManifestSchema.safeParse({
      ...valid,
      contributes: { providers },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const duplicateIssues = parsed.error.issues.filter((issue) =>
        issue.message.includes("more than once"),
      )
      expect(duplicateIssues.length).toBe(1)
    }
  })

  it("accepts a manifest whose contributions all have distinct ids", () => {
    const parsed = ExtensionManifestSchema.safeParse({
      ...valid,
      contributes: { providers: [contribution("a"), contribution("b")] },
    })
    expect(parsed.success).toBe(true)
  })
})

describe("parseManifest", () => {
  it("keeps known contribution keys when the manifest declares them", () => {
    const result = parseManifest({ ...valid, contributes: { providers: [] } })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.value.manifest.contributes.providers).toEqual([])
  })

  it("ignores an unknown contribution key and reports it rather than failing", () => {
    const result = parseManifest({
      ...valid,
      contributes: { providers: [], themes: [{ name: "midnight" }] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.ignoredContributions).toEqual(["themes"])
  })

  it("rejects a manifest declaring a newer api major", () => {
    const result = parseManifest({ ...valid, apiVersion: "spectrum.dev/v2" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("unsupported-api-version")
  })

  it("rejects a manifest declaring an unrecognised api group", () => {
    const result = parseManifest({ ...valid, apiVersion: "example.com/v1" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("unsupported-api-version")
  })

  it("rejects as invalid-manifest a manifest whose own contributions collide on id", () => {
    const result = parseManifest({
      ...valid,
      contributes: { providers: [contribution("dup"), contribution("dup")] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-manifest")
  })
})
