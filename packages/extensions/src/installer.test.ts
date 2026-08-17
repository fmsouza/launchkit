import { describe, expect, it } from "bun:test"
import type { PluginInstall } from "@spectrum/config"
import { PluginIdSchema } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { createInMemoryExtensionFileSource } from "./file-source"
import { createFakeGitClient, createInMemoryDirCopier } from "./git"
import { createExtensionInstaller } from "./installer"

const pid = (id: string) => PluginIdSchema.parse(id)

const contribution = (id: string): unknown => ({
  id,
  descriptor: {
    label: `Acme ${id}`,
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    reasoning: { shape: "none", supportedTiers: [] },
    discovery: { strategy: "openai-models" },
  },
  transport: {
    kind: "http",
    wire: "openai",
    launch: {
      command: "/usr/local/bin/acme-server",
      args: ["--port", "{{port}}"],
      envTemplate: { ACME_KEY: "{{apiKey}}", SPECTRUM_TOKEN: "{{hostToken}}" },
    },
  },
})

const validManifest = (id: string, contributionId = id): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id,
  name: `Acme ${id}`,
  version: "1.0.0",
  contributes: { providers: [contribution(contributionId)] },
})

const v2Manifest = (id: string): unknown => ({
  ...(validManifest(id) as Record<string, unknown>),
  apiVersion: "spectrum.dev/v99",
})

const gitInstall = (id: string): PluginInstall => ({
  id: pid(id),
  source: {
    kind: "git",
    url: "https://example.com/acme.git",
    ref: "HEAD",
    commit: "abc123",
  },
  enabled: true,
})

const linkedInstall = (id: string, path = "/src/acme"): PluginInstall => ({
  id: pid(id),
  source: { kind: "path", path, linked: true },
  enabled: true,
})

/**
 * `manifests` maps a directory to the raw manifest `readManifest` returns for it. A git
 * install writes its manifest at the write dir, so the harness registers it there when a
 * clone is expected to succeed.
 */
const harness = (opts: {
  manifests?: Readonly<Record<string, unknown>>
  /** Manifests already ON DISK under the plugin root, by directory id — what the
   *  contribution-collision check reads through `fileSource.listExtensions()`. */
  onDisk?: Readonly<Record<string, unknown>>
  present?: readonly string[]
  installed?: readonly PluginInstall[]
  gitFailure?: { kind: "git-failed"; detail: string }
  commit?: string
}) => {
  const copier = createInMemoryDirCopier(opts.present ?? [])
  const git = createFakeGitClient({
    ...(opts.commit === undefined ? {} : { commit: opts.commit }),
    ...(opts.gitFailure === undefined ? {} : { failure: opts.gitFailure }),
  })
  // A real clone writes a tree at the destination; the fake records the same fact so
  // "deletes the clone" assertions test something rather than passing trivially.
  const cloningGit = {
    ...git,
    clone: async (url: string, dest: string, ref?: string) => {
      const r = await git.clone(url, dest, ref)
      if (r.ok) copier.add(dest)
      return r
    },
  }
  const fileSource = createInMemoryExtensionFileSource(
    Object.entries(opts.onDisk ?? {}).map(([id, raw]) => ({ id, raw })),
  )
  const removed: string[] = []
  const wrapped = {
    ...fileSource,
    removeExtension: async (id: string) => {
      removed.push(id)
      copier.drop(`/data/providers/${id}`)
      return ok(undefined)
    },
  }
  const manifests = opts.manifests ?? {}
  const installer = createExtensionInstaller({
    git: cloningGit,
    copier,
    fileSource: wrapped,
    readManifest: async (dir: string) =>
      Object.hasOwn(manifests, dir)
        ? ok(manifests[dir])
        : err({ kind: "not-found", id: dir }),
    pluginRoot: "/data/providers",
    existingInstalls: () => opts.installed ?? [],
  })
  return { installer, git, copier, removed }
}

/** A clone "writes" the tree: the fake git client marks its destination present. */
describe("install — git", () => {
  it("clones, records the resolved commit, and returns the validated manifest", async () => {
    const { installer, git } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
      commit: "abc123",
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.install.source).toEqual({
        kind: "git",
        url: "https://example.com/acme.git",
        ref: "HEAD",
        commit: "abc123",
      })
    expect(git.calls.map((c) => c.op)).toEqual(["clone", "revParse"])
  })

  it("enables the extension on install because installing is the trust decision", async () => {
    const { installer } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.install.enabled).toBe(true)
  })

  it("deletes the clone when the manifest fails validation", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": { apiVersion: "spectrum.dev/v1" } },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
    expect(removed).toEqual(["acme"])
  })

  it("deletes the clone when the manifest id does not match the install id", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": validManifest("other") },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
    expect(removed).toEqual(["acme"])
  })

  it("deletes the clone when the manifest needs a newer api version", async () => {
    const { installer, copier, removed } = harness({
      manifests: { "/data/providers/acme": v2Manifest("acme") },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-api-version")
    expect(removed).toEqual(["acme"])
    expect(await copier.exists("/data/providers/acme")).toBe(false)
  })

  it("deletes the clone when a launch template names an undeclared token", async () => {
    const bad = validManifest("acme") as {
      contributes: {
        providers: { transport: { launch: { args: string[] } } }[]
      }
    }
    // biome-ignore lint/style/noNonNullAssertion: brief's test harness guarantees providers[0] exists
    bad.contributes.providers[0]!.transport.launch.args = ["{{nope}}"]
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": bad },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    expect(removed).toEqual(["acme"])
  })

  it("refuses when a contributed provider id is already claimed by another extension", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/beta": validManifest("beta", "acme") },
      // "acme" is already installed on disk and contributes the id "acme"; the incoming
      // "beta" manifest contributes that same id.
      onDisk: { acme: validManifest("acme") },
      installed: [gitInstall("acme")],
    })
    const r = await installer.install({
      source: "https://example.com/beta.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "duplicate-id")
      expect(r.error.id).toBe("acme")
    expect(removed).toEqual(["beta"])
  })

  it("fails with git-failed and writes nothing when the clone fails", async () => {
    const { installer, copier } = harness({
      gitFailure: { kind: "git-failed", detail: "exit 128" },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("git-failed")
    expect(await copier.exists("/data/providers/acme")).toBe(false)
  })
})

describe("install — path", () => {
  it("records a linked source and copies nothing when mode is link", async () => {
    const { installer, copier } = harness({
      manifests: { "/src/acme": validManifest("acme") },
      present: ["/src/acme"],
    })
    const r = await installer.install({ source: "/src/acme" })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.install.source).toEqual({
        kind: "path",
        path: "/src/acme",
        linked: true,
      })
    expect(copier.copies).toEqual([])
    expect(await copier.exists("/data/providers/acme")).toBe(false)
  })

  it("copies into the plugin root and records linked false when mode is copy", async () => {
    const { installer, copier } = harness({
      manifests: {
        "/src/acme": validManifest("acme"),
        "/data/providers/acme": validManifest("acme"),
      },
      present: ["/src/acme"],
    })
    const r = await installer.install({ source: "/src/acme", mode: "copy" })
    expect(r.ok).toBe(true)
    if (r.ok && r.value.install.source.kind === "path")
      expect(r.value.install.source.linked).toBe(false)
    expect(await copier.exists("/data/providers/acme")).toBe(true)
  })

  it("fails without copying when the source directory holds no manifest", async () => {
    const { installer, copier } = harness({ present: ["/src/acme"] })
    const r = await installer.install({ source: "/src/acme" })
    expect(r.ok).toBe(false)
    expect(copier.copies).toEqual([])
  })

  it("reports source-unavailable when a linked source path does not exist", async () => {
    const { installer } = harness({})
    const r = await installer.install({ source: "/src/missing" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("source-unavailable")
  })
})

describe("update", () => {
  it("fetches the pinned ref and records the new commit when the manifest stays valid", async () => {
    const { installer, git } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
      installed: [gitInstall("acme")],
      commit: "feed01",
    })
    const r = await installer.update(pid("acme"), gitInstall("acme"))
    expect(r.ok).toBe(true)
    if (r.ok && r.value.install.source.kind === "git")
      expect(r.value.install.source.commit).toBe("feed01")
    expect(git.calls.map((c) => c.op)).toEqual(["fetchCheckout", "revParse"])
  })

  it("fails without adopting the new tree when the updated manifest is invalid", async () => {
    const { installer } = harness({
      manifests: { "/data/providers/acme": v2Manifest("acme") },
      installed: [gitInstall("acme")],
      commit: "feed01",
    })
    const r = await installer.update(pid("acme"), gitInstall("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-api-version")
  })

  it("never deletes the extension when an update fails, so the old install survives", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": v2Manifest("acme") },
      installed: [gitInstall("acme")],
    })
    await installer.update(pid("acme"), gitInstall("acme"))
    expect(removed).toEqual([])
  })

  it("refuses to update a linked path install because there is nothing to fetch", async () => {
    const { installer, git } = harness({
      manifests: { "/src/acme": validManifest("acme") },
      present: ["/src/acme"],
      installed: [linkedInstall("acme")],
    })
    const r = await installer.update(pid("acme"), linkedInstall("acme"))
    expect(r.ok).toBe(false)
    expect(git.calls).toEqual([])
  })

  it("refuses to update a local hand-placed extension", async () => {
    const local: PluginInstall = {
      id: pid("acme"),
      source: { kind: "local" },
      enabled: true,
    }
    const { installer } = harness({ installed: [local] })
    const r = await installer.update(pid("acme"), local)
    expect(r.ok).toBe(false)
  })
})

describe("remove", () => {
  it("deletes the extension directory when nothing references it", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
      installed: [gitInstall("acme")],
    })
    const r = await installer.remove(pid("acme"), gitInstall("acme"), [])
    expect(r.ok).toBe(true)
    expect(removed).toEqual(["acme"])
  })

  it("refuses with in-use and lists the providers when a provider still references it", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
      installed: [gitInstall("acme")],
    })
    const r = await installer.remove(pid("acme"), gitInstall("acme"), [
      "prv_1",
      "prv_2",
    ])
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "in-use")
      expect(r.error.providerIds).toEqual(["prv_1", "prv_2"])
    expect(removed).toEqual([])
  })

  it("never deletes the source directory when removing a linked install", async () => {
    const { installer, copier, removed } = harness({
      manifests: { "/src/acme": validManifest("acme") },
      present: ["/src/acme"],
      installed: [linkedInstall("acme")],
    })
    const r = await installer.remove(pid("acme"), linkedInstall("acme"), [])
    expect(r.ok).toBe(true)
    expect(removed).toEqual([])
    expect(await copier.exists("/src/acme")).toBe(true)
  })
})
