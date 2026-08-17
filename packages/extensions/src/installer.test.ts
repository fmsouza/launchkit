import { describe, expect, it } from "bun:test"
import type { PluginInstall } from "@spectrum/config"
import type { Platform } from "@spectrum/platform"
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
  /** Fixed so `planInstall`'s path-joining behaviour does not depend on the host running the
   * suite — without this, the installer falls back to `detectPlatform()` and the POSIX path
   * literals throughout this file (e.g. `/data/providers/acme`) are only correct by accident
   * of running on a POSIX host. Override to `"windows"` to pin the win32-path-joining case. */
  platform?: Platform
  pluginRoot?: string
}) => {
  const copier = createInMemoryDirCopier(opts.present ?? [])
  const git = createFakeGitClient({
    ...(opts.commit === undefined ? {} : { commit: opts.commit }),
    ...(opts.gitFailure === undefined ? {} : { failure: opts.gitFailure }),
    // `update` reads its candidate manifest out of `FETCH_HEAD`, not off disk, so the same
    // `manifests` map serves both paths: as directory contents for `install`'s
    // `readManifest`, and as the fetched bytes for `update`'s `showFetchHead`.
    fetchHead: Object.fromEntries(
      Object.entries(opts.manifests ?? {}).map(([dir, raw]) => [
        dir,
        JSON.stringify(raw),
      ]),
    ),
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
  const pluginRoot = opts.pluginRoot ?? "/data/providers"
  const removed: string[] = []
  const wrapped = {
    ...fileSource,
    removeExtension: async (id: string) => {
      removed.push(id)
      copier.drop(`${pluginRoot}/${id}`)
      return ok(undefined)
    },
    // Deliberately NOT `${pluginRoot}/${id}` (== `join(pluginRoot, id)`) — a
    // byte-identical override would make `update` calling `fileSource.extensionDir(id)`
    // indistinguishable from re-deriving `pluginRoot/id` itself, so sabotaging that wiring
    // would break zero tests. `/fs/<id>` is a distinct layout the two definitions could
    // only agree on by actually going through this override, and the `update` tests below
    // assert the git calls land on THIS path.
    extensionDir: (id: string) => `/fs/${id}`,
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
    pluginRoot,
    platform: opts.platform ?? "macos",
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

  /** `git clone --branch HEAD` is a FATAL error — `HEAD` is a symref, not a name under
   * `refs/heads`/`refs/tags` — so the recorded `ref: "HEAD"` (which `fetch` does accept, and
   * which `update` depends on) must never be synthesised into the clone. Omitting `--branch`
   * is what gets the remote's default branch. */
  it("clones the remote's default branch when no ref was requested", async () => {
    const { installer, git } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
    })
    await installer.install({ source: "https://example.com/acme.git" })
    const clone = git.calls.find((c) => c.op === "clone")
    expect(clone?.args).toEqual([
      "https://example.com/acme.git",
      "/data/providers/acme",
    ])
  })

  it("passes an explicitly requested ref through to the clone", async () => {
    const { installer, git } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
    })
    await installer.install({
      source: "https://example.com/acme.git",
      ref: "v1.2.3",
    })
    const clone = git.calls.find((c) => c.op === "clone")
    expect(clone?.args).toEqual([
      "https://example.com/acme.git",
      "/data/providers/acme",
      "v1.2.3",
    ])
  })

  /** `"HEAD"` is the literal value the install record persists and `plugin list` prints, so
   * a user copying what they see types it straight back in — and it renders the fatal
   * `clone --branch HEAD` all over again. An explicit `HEAD` means the same thing as no ref
   * at all. */
  it("treats an explicitly requested HEAD ref as the default branch", async () => {
    const { installer, git } = harness({
      manifests: { "/data/providers/acme": validManifest("acme") },
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
      ref: "HEAD",
    })
    expect(r.ok).toBe(true)
    const clone = git.calls.find((c) => c.op === "clone")
    expect(clone?.args).toEqual([
      "https://example.com/acme.git",
      "/data/providers/acme",
    ])
    // The record still says HEAD — `git fetch origin HEAD` accepts it, and `update` needs it.
    if (r.ok && r.value.install.source.kind === "git")
      expect(r.value.install.source.ref).toBe("HEAD")
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
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")
    if (!r.ok && r.error.kind === "duplicate-id")
      expect(r.error.id).toBe("acme")
    expect(removed).toEqual(["beta"])
  })

  it("installs cleanly past a broken neighbour whose manifest fails to parse", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/beta": validManifest("beta") },
      // "broken" is on disk but its manifest is garbage — must be skipped, not fail the
      // batch, so it never blocks an unrelated install.
      onDisk: { broken: { not: "a manifest" } },
    })
    const r = await installer.install({
      source: "https://example.com/beta.git",
    })
    expect(r.ok).toBe(true)
    expect(removed).toEqual([])
  })

  it("still catches a real contribution-id collision with a broken neighbour present", async () => {
    const { installer, removed } = harness({
      manifests: { "/data/providers/beta": validManifest("beta", "acme") },
      onDisk: {
        broken: { not: "a manifest" },
        acme: validManifest("acme"),
      },
      installed: [gitInstall("acme")],
    })
    const r = await installer.install({
      source: "https://example.com/beta.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")
    if (!r.ok && r.error.kind === "duplicate-id")
      expect(r.error.id).toBe("acme")
    expect(removed).toEqual(["beta"])
  })

  /** `GitClient` is an injected adapter, not in-package logic — its `Result<string, ...>`
   * contract is trusted, not enforced by the type system at the call site. A misbehaving
   * adapter whose `revParse` reports success with no commit must not silently produce a
   * `PluginInstall` with an undefined commit; the installer's own guard has to catch it. */
  it("fails with write-failed when the git client reports success with no commit", async () => {
    const copier = createInMemoryDirCopier(["/data/providers/acme"])
    const misbehavingGit = {
      calls: [] as { op: string; args: readonly string[] }[],
      clone: async (_url: string, dest: string) => {
        copier.add(dest)
        return ok(undefined)
      },
      fetch: async () => ok(undefined),
      showFetchHead: async () => ok("{}"),
      checkoutFetchHead: async () => ok(undefined),
      revParse: async () => ok(undefined as unknown as string),
    }
    const fileSource = createInMemoryExtensionFileSource([])
    const installer = createExtensionInstaller({
      git: misbehavingGit,
      copier,
      fileSource,
      readManifest: async (dir: string) =>
        dir === "/data/providers/acme"
          ? ok(validManifest("acme"))
          : err({ kind: "not-found", id: dir }),
      pluginRoot: "/data/providers",
      existingInstalls: () => [],
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("write-failed")
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

  /** Pins the installer's Windows path behaviour explicitly, rather than relying on it only
   * running correctly by accident of `detectPlatform()` matching whatever host runs the
   * suite. Without `platform` threaded from `createExtensionInstaller` into `planInstall`,
   * this fails on any non-Windows host that forces `platform: "windows"`, exactly as it fails
   * for real on Windows CI when the host platform IS windows but the test's directory
   * literals are POSIX. */
  it("clones into a backslash-joined write dir when the platform is windows", async () => {
    const { installer, git } = harness({
      platform: "windows",
      pluginRoot: "C:\\data\\providers",
      manifests: { "C:\\data\\providers\\acme": validManifest("acme") },
      commit: "abc123",
    })
    const r = await installer.install({
      source: "https://example.com/acme.git",
    })
    expect(r.ok).toBe(true)
    const clone = git.calls.find((c) => c.op === "clone")
    expect(clone?.args).toEqual([
      "https://example.com/acme.git",
      "C:\\data\\providers\\acme",
    ])
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
    if (r.ok) expect(r.value.install.source.kind).toBe("path")
    if (r.ok && r.value.install.source.kind === "path")
      expect(r.value.install.source.linked).toBe(false)
    expect(await copier.exists("/data/providers/acme")).toBe(true)
  })

  /** `createFsDirCopier` can fail mid-copy in production (EACCES, ENOSPC, its own
   * self/descendant guard) even after `exists` reported the source present and the
   * destination free — an untested cleanup path here is exactly the "shipped with no test
   * behind it" pattern being eliminated elsewhere in this task. */
  it("cleans up the partial write when a copy fails after the destination-occupied check passes", async () => {
    const failingCopier = {
      exists: async (dir: string) => dir === "/src/acme",
      copy: async () => err({ kind: "read-failed", detail: "ENOSPC" } as const),
    }
    const removed: string[] = []
    const fileSource = {
      ...createInMemoryExtensionFileSource([]),
      removeExtension: async (id: string) => {
        removed.push(id)
        return ok(undefined)
      },
    }
    const installer = createExtensionInstaller({
      git: createFakeGitClient(),
      copier: failingCopier,
      fileSource,
      readManifest: async () => err({ kind: "not-found", id: "unused" }),
      pluginRoot: "/data/providers",
      existingInstalls: () => [],
    })
    const r = await installer.install({ source: "/src/acme", mode: "copy" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
    expect(removed).toEqual(["acme"])
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

  /** Rule 6's cleanup is gated on `plan.writeDir !== undefined`, not on "did an error
   * happen" — a linked install never has a `writeDir`, so `removeExtension` must never be
   * called for it even when validation fails. Nothing in the git-install failure tests
   * above pins this: they all have a `writeDir`, so removing `if (plan.writeDir ===
   * undefined) return` from `cleanupAfterFailure` breaks zero tests without this one. */
  it("never calls removeExtension when a linked install's manifest fails validation", async () => {
    const { installer, removed, copier } = harness({
      manifests: { "/src/acme": validManifest("other") },
      present: ["/src/acme"],
    })
    const r = await installer.install({ source: "/src/acme" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
    expect(removed).toEqual([])
    expect(await copier.exists("/src/acme")).toBe(true)
  })

  it("refuses with duplicate-id and copies nothing when the copy destination is already occupied", async () => {
    const { installer, copier } = harness({
      manifests: { "/src/acme": validManifest("acme") },
      // A hand-placed directory at the destination — not in `existingInstalls()`, since
      // Spectrum never recorded installing it, so `planInstall`'s own duplicate-id check
      // (which only looks at existingIds) does not see it as taken.
      present: ["/src/acme", "/data/providers/acme"],
    })
    const r = await installer.install({ source: "/src/acme", mode: "copy" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")
    expect(copier.copies).toEqual([])
  })
})

describe("update", () => {
  it("fetches the pinned ref and records the new commit when the manifest stays valid", async () => {
    const { installer, git } = harness({
      // Keyed by `fileSource.extensionDir("acme")` (`/fs/acme`), NOT `pluginRoot/id` — if
      // `update` ever went back to re-deriving `join(pluginRoot, id)` instead of asking
      // the file source, this manifest would go unread and the test would fail on `r.ok`.
      manifests: { "/fs/acme": validManifest("acme") },
      installed: [gitInstall("acme")],
      commit: "feed01",
    })
    const r = await installer.update(pid("acme"), gitInstall("acme"))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.install.source.kind).toBe("git")
    if (r.ok && r.value.install.source.kind === "git")
      expect(r.value.install.source.commit).toBe("feed01")
    expect(git.calls.map((c) => c.op)).toEqual([
      "fetch",
      "showFetchHead",
      "checkoutFetchHead",
      "revParse",
    ])
    expect(git.calls.map((c) => c.args[0])).toEqual([
      "/fs/acme",
      "/fs/acme",
      "/fs/acme",
      "/fs/acme",
    ])
  })

  /** The refusal must land BEFORE the checkout, not after it: `registry.list()` batch-fails
   * on an invalid manifest or a duplicate id, so a bad commit left checked out takes every
   * other installed extension down with it. */
  it("never checks out the fetched commit when the updated manifest is invalid", async () => {
    const { installer, git } = harness({
      manifests: { "/fs/acme": v2Manifest("acme") },
      installed: [gitInstall("acme")],
      commit: "feed01",
    })
    const r = await installer.update(pid("acme"), gitInstall("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-api-version")
    expect(git.calls.map((c) => c.op)).toEqual(["fetch", "showFetchHead"])
  })

  it("never checks out the fetched commit when its contribution id collides with a neighbour", async () => {
    const { installer, git } = harness({
      manifests: { "/fs/acme": validManifest("acme", "shared") },
      onDisk: { neighbour: validManifest("neighbour", "shared") },
      installed: [gitInstall("acme")],
    })
    const r = await installer.update(pid("acme"), gitInstall("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")
    expect(git.calls.map((c) => c.op)).not.toContain("checkoutFetchHead")
  })

  it("never deletes the extension when an update fails, so the old install survives", async () => {
    const { installer, removed } = harness({
      manifests: { "/fs/acme": v2Manifest("acme") },
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

  it("refuses to update a copy-mode path install, with a message distinct from the linked one", async () => {
    const copyInstall: PluginInstall = {
      id: pid("acme"),
      source: { kind: "path", path: "/src/acme", linked: false },
      enabled: true,
    }
    const { installer, git } = harness({ installed: [copyInstall] })
    const r = await installer.update(pid("acme"), copyInstall)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
    if (!r.ok && r.error.kind === "invalid-manifest")
      expect(r.error.detail).not.toContain("linked")
    expect(git.calls).toEqual([])
  })

  it("refuses when the install record's id does not match the requested id", async () => {
    const { installer, git } = harness({
      manifests: { "/fs/acme": validManifest("acme") },
      installed: [gitInstall("acme")],
    })
    const r = await installer.update(pid("other"), gitInstall("acme"))
    expect(r.ok).toBe(false)
    expect(git.calls).toEqual([])
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
    if (!r.ok) expect(r.error.kind).toBe("in-use")
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

  /** A `local` hand-placed install is the other "Spectrum never acquired these files" case
   * alongside `linked` — nothing pinned it before this test, so making `remove` delete
   * unconditionally would only have broken the `linked` test above. */
  it("never calls removeExtension for a local hand-placed install", async () => {
    const local: PluginInstall = {
      id: pid("acme"),
      source: { kind: "local" },
      enabled: true,
    }
    const { installer, removed } = harness({ installed: [local] })
    const r = await installer.remove(pid("acme"), local, [])
    expect(r.ok).toBe(true)
    expect(removed).toEqual([])
  })
})
