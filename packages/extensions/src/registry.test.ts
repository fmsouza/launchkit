import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { PluginIdSchema } from "@spectrum/types"
import { createInMemoryExtensionFileSource } from "./file-source"
import { createExtensionRegistry } from "./registry"

const pid = (id: string) => PluginIdSchema.parse(id)

/** Overrides for the identity-bearing fields of a provider-contribution fixture. */
type ProviderOverrides = {
  id?: string
  wire?: "openai" | "anthropic"
  launchArgs?: readonly string[]
}

const provider = (id: string, overrides: ProviderOverrides = {}) => ({
  id: overrides.id ?? id,
  descriptor: {
    label: id,
    reasoning: { shape: "none", supportedTiers: [] },
    discovery: { strategy: "none" },
  },
  transport: {
    kind: "http",
    wire: overrides.wire ?? "openai",
    ...(overrides.launchArgs !== undefined
      ? {
          launch: {
            command: "serve",
            args: overrides.launchArgs,
            envTemplate: {},
          },
        }
      : {}),
  },
})

/** A complete, well-formed raw manifest, keyed by id, matching what a real file source reads. */
const ext = (
  id: string,
  contributes: Record<string, unknown> = { providers: [provider(id)] },
) => ({
  id,
  raw: {
    apiVersion: "spectrum.dev/v1",
    id,
    name: `Extension ${id}`,
    version: "1.0.0",
    contributes,
  },
})

type RecordedCall = {
  readonly level: string
  readonly msg: string
  readonly fields?: Record<string, unknown>
}

/** Records every call made to it, without writing to the console. */
const recordingLogger = (): Logger & { calls: RecordedCall[] } => {
  const calls: RecordedCall[] = []
  const record = (
    level: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    calls.push(fields === undefined ? { level, msg } : { level, msg, fields })
  }
  const self = {
    calls,
    debug: (msg: string, fields?: Record<string, unknown>) =>
      record("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) =>
      record("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      record("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) =>
      record("error", msg, fields),
    fatal: (msg: string, fields?: Record<string, unknown>) =>
      record("fatal", msg, fields),
    child: () => self,
  }
  return self
}

describe("createExtensionRegistry", () => {
  describe("list", () => {
    it("returns every valid extension when the directory holds several", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([ext("a"), ext("b")]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.map((e) => String(e.manifest.id))).toEqual([
          "a",
          "b",
        ])
      }
    })

    it("fails with invalid-manifest when an entry does not match the schema", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          { id: "a", raw: { apiVersion: "spectrum.dev/v1", id: "a" } }, // missing name/version
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe("invalid-manifest")
    })

    it("fails with duplicate-id when two extensions claim the same id", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          {
            // Directory id matches manifest id on both entries — the collision under test
            // is the shared "dup" identity, not a directory/manifest-id mismatch.
            id: "dup",
            raw: {
              apiVersion: "spectrum.dev/v1",
              id: "dup",
              name: "One",
              version: "1.0.0",
              contributes: { providers: [] },
            },
          },
          {
            id: "dup",
            raw: {
              apiVersion: "spectrum.dev/v1",
              id: "dup",
              name: "Two",
              version: "1.0.0",
              contributes: { providers: [] },
            },
          },
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({ kind: "duplicate-id", id: "dup" })
      }
    })

    it("fails with invalid-manifest when the manifest id disagrees with the directory it was read from", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          {
            id: "myext", // the directory/entry id the file source read this from
            raw: {
              apiVersion: "spectrum.dev/v1",
              id: "different", // what the manifest itself claims
              name: "Mismatched",
              version: "1.0.0",
              contributes: { providers: [] },
            },
          },
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-manifest")
        if (result.error.kind === "invalid-manifest") {
          expect(result.error.detail).toContain("myext")
          expect(result.error.detail).toContain("different")
        }
      }
    })

    it("fails with unsupported-api-version when an extension needs a newer Spectrum", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          {
            id: "a",
            raw: {
              apiVersion: "spectrum.dev/v99",
              id: "a",
              name: "A",
              version: "1.0.0",
            },
          },
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe("unsupported-api-version")
    })

    it("fails with invalid-manifest when a launch template uses an undeclared token", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          ext("a", {
            providers: [
              provider("a", { launchArgs: ["--secret", "{{nope}}"] }),
            ],
          }),
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe("invalid-manifest")
    })

    it("reports ignored contribution keys rather than failing on them", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          ext("a", { providers: [], themes: [] }),
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.value[0]?.ignoredContributions).toEqual(["themes"])
    })

    it("logs exactly one warn per extension naming its ignoredContributions", async () => {
      const logger = recordingLogger()
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          ext("a", { providers: [], themes: [], panels: [] }),
          ext("b", { providers: [] }), // nothing ignored
        ]),
        logger,
      })
      const result = await registry.list()
      expect(result.ok).toBe(true)

      const warns = logger.calls.filter((c) => c.level === "warn")
      expect(warns).toHaveLength(1)
      expect(warns[0]?.fields?.id).toBe("a")
      expect(warns[0]?.fields?.ignoredContributions).toEqual([
        "themes",
        "panels",
      ])
    })

    it("does not warn when logger is omitted, defaulting to a noop logger", async () => {
      // No logger supplied: createExtensionRegistry must default to createNoopLogger()
      // rather than throwing on `deps.logger.warn(...)`.
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          ext("a", { providers: [], themes: [] }),
        ]),
      })
      const result = await registry.list()
      expect(result.ok).toBe(true)
    })

    it("attaches each extension's dir from the file source's extensionDir", async () => {
      const fileSource = createInMemoryExtensionFileSource([ext("a")])
      const registry = createExtensionRegistry({ fileSource })
      const result = await registry.list()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value[0]?.dir).toBe(fileSource.extensionDir(pid("a")))
      }
    })

    it("loads the rest when one linked extension's source is unavailable", async () => {
      const fileSource = createInMemoryExtensionFileSource([ext("a")])
      const originalList = fileSource.listExtensions.bind(fileSource)
      const wrapped = {
        ...fileSource,
        listExtensions: async () => {
          const result = await originalList()
          if (!result.ok) return result
          return {
            ok: true as const,
            value: [
              ...result.value,
              {
                id: "dead",
                error: {
                  kind: "source-unavailable" as const,
                  id: "dead",
                  path: "/nowhere",
                },
              },
            ],
          }
        },
      }
      const registry = createExtensionRegistry({ fileSource: wrapped })
      const result = await registry.list()
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.value.map((e) => String(e.manifest.id))).toEqual(["a"])
    })

    it("propagates a read failure when the file source fails", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([], {
          kind: "read-failed",
          detail: "boom",
        }),
      })
      const result = await registry.list()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({ kind: "read-failed", detail: "boom" })
      }
    })
  })

  describe("providerDescriptors", () => {
    it("returns provider descriptors for enabled ids only", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([ext("a"), ext("b")]),
      })
      const result = await registry.providerDescriptors(["a"])
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.value.map((d) => d.key)).toEqual(["plugin:a"])
    })

    it("returns descriptors for every provider when one extension contributes several", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([
          ext("multi", {
            providers: [provider("first"), provider("second")],
          }),
        ]),
      })
      const result = await registry.providerDescriptors(["multi"])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.map((d) => d.key)).toEqual([
          "plugin:first",
          "plugin:second",
        ])
      }
    })

    it("returns an empty list when no extension id is enabled", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([ext("a"), ext("b")]),
      })
      const result = await registry.providerDescriptors([])
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toEqual([])
    })

    it("propagates a read failure when the file source fails", async () => {
      const registry = createExtensionRegistry({
        fileSource: createInMemoryExtensionFileSource([], {
          kind: "read-failed",
          detail: "boom",
        }),
      })
      const result = await registry.providerDescriptors(["a"])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({ kind: "read-failed", detail: "boom" })
      }
    })
  })
})
