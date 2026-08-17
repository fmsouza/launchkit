import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginIdSchema, pluginKeyOf } from "@spectrum/types"
import type { AppContext } from "./app-context"
import { createAppContext } from "./create-app-context"
import type { CreateAppContextDeps } from "./deps"
import { buildFakeAppContextDeps, realAdapterDefaults } from "./test-support"

/**
 * Proves the plan's headline claim for link-mode installs: editing a LINKED working copy on
 * disk changes what Spectrum serves after the next `refreshExtensions()`, with no reinstall.
 * This is a property of `ExtensionAdmin` + the config-derived link map (`create-app-context.ts`'s
 * `runRefresh`) + the provider registry, not of any one package in isolation — hence it lives
 * here rather than in `@spectrum/extensions` or `@spectrum/runtime-core`'s unit tests.
 *
 * Everything below the manifest is production code with production adapters (real fs, real
 * config file, real extension registry, real provider registry). Only the db/session/secret
 * layers are stubbed, mirroring `create-app-context.test.ts`'s `buildFakeAppContextDeps` —
 * this scenario never touches sessions, projects, or secrets.
 */

const manifestFor = (label: string): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id: "linked-plugin",
  name: "Linked Plugin",
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: "linked-plugin",
        descriptor: {
          label,
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "none" },
        },
        // No `launch` block: this contribution is a user-run server, never supervised, so the
        // scenario needs no provider-host child process — only the descriptor's label is read.
        transport: { kind: "http", wire: "openai" },
      },
    ],
  },
})

/** A manifest whose MANIFEST id and CONTRIBUTION id can be set independently — needed to
 * reproduce a duplicate-contribution-id collision between two DIFFERENT extensions. */
const manifestWith = (input: {
  readonly manifestId: string
  readonly contributionId: string
  readonly label: string
}): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id: input.manifestId,
  name: input.manifestId,
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: input.contributionId,
        descriptor: {
          label: input.label,
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "none" },
        },
        transport: { kind: "http", wire: "openai" },
      },
    ],
  },
})

let tmpRoot = ""
let workingCopy = ""
let dataDir = ""
let ctx: AppContext

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "spectrum-extension-admin-"))
  workingCopy = join(tmpRoot, "working-copy")
  dataDir = join(tmpRoot, "data")
  await mkdir(workingCopy, { recursive: true })
  await writeFile(
    join(workingCopy, "spectrum-extension.json"),
    JSON.stringify(manifestFor("Linked v1"), null, 2),
    "utf8",
  )

  const paths = {
    dataDir,
    configFile: join(dataDir, "config.json"),
    dbFile: join(dataDir, "spectrum.db"),
    harnessDir: join(dataDir, "harnesses"),
    providerPluginDir: join(dataDir, "providers"),
    runtimeFile: join(dataDir, "runtime.json"),
    secretsDir: join(dataDir, "secrets"),
    uploadsDir: join(dataDir, "uploads"),
  }

  const deps = buildFakeAppContextDeps({
    resolveAppPaths: () => paths,
    // Real config persistence: the admin's `config.save` and the refresh's `config.load` must
    // observe each other's writes, which the default in-memory `buildFakeAppContextDeps` stub
    // (a fixed `defaultConfig()` on every load) does not provide.
    createFsConfigFile:
      realAdapterDefaults.createFsConfigFile as CreateAppContextDeps["createFsConfigFile"],
    createFileConfigStore:
      realAdapterDefaults.createFileConfigStore as CreateAppContextDeps["createFileConfigStore"],
    createCachedConfigStore:
      realAdapterDefaults.createCachedConfigStore as CreateAppContextDeps["createCachedConfigStore"],
    // Real extension + provider-plugin layer end to end: the file source reads the plugin root
    // (and, for a linked install, the working copy) live; the registry parses what it finds;
    // the provider registry projects the resulting descriptors.
    createDirExtensionFileSource:
      realAdapterDefaults.createDirExtensionFileSource as CreateAppContextDeps["createDirExtensionFileSource"],
    createExtensionRegistry:
      realAdapterDefaults.createExtensionRegistry as CreateAppContextDeps["createExtensionRegistry"],
    createProviderRegistry:
      realAdapterDefaults.createProviderRegistry as CreateAppContextDeps["createProviderRegistry"],
    // The installer's own dep chain, real end to end (a `path` source install never calls git,
    // but the git client is still constructed at wiring time).
    createProcessGitClient:
      realAdapterDefaults.createProcessGitClient as CreateAppContextDeps["createProcessGitClient"],
    createFsDirCopier:
      realAdapterDefaults.createFsDirCopier as CreateAppContextDeps["createFsDirCopier"],
    createFsReadManifest:
      realAdapterDefaults.createFsReadManifest as CreateAppContextDeps["createFsReadManifest"],
    createBunCaptureStdout:
      realAdapterDefaults.createBunCaptureStdout as CreateAppContextDeps["createBunCaptureStdout"],
    createExtensionInstaller:
      realAdapterDefaults.createExtensionInstaller as CreateAppContextDeps["createExtensionInstaller"],
    createPathCommandResolver:
      realAdapterDefaults.createPathCommandResolver as CreateAppContextDeps["createPathCommandResolver"],
  })

  ctx = createAppContext(deps)
  // Let the constructor's own initial refresh (against an empty plugin root) settle before the
  // scenario's install, so the first assertion is against a refresh THIS test triggered.
  await ctx.refreshExtensions()
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("link-mode live reload", () => {
  it("serves an edited working copy's new label after refresh, with no reinstall", async () => {
    const installed = await ctx.extensions.install({
      source: workingCopy,
      id: "linked-plugin",
    })
    expect(installed.ok).toBe(true)

    await ctx.refreshExtensions()

    const key = pluginKeyOf(PluginIdSchema.parse("linked-plugin"))
    const before = ctx.providerRegistry.get(key)
    expect(before?.label).toBe("Linked v1")

    // Rewrite the manifest ON DISK, at the working copy — not the plugin root. A link install
    // never copies into the plugin root, so this is the only place a live-reloaded edit can
    // land.
    await writeFile(
      join(workingCopy, "spectrum-extension.json"),
      JSON.stringify(manifestFor("Linked v2"), null, 2),
      "utf8",
    )

    await ctx.refreshExtensions()

    const after = ctx.providerRegistry.get(key)
    expect(after?.label).toBe("Linked v2")
  })
})

describe("duplicate-contribution guard sees already-installed linked extensions", () => {
  it("refuses a second extension that claims a linked extension's contribution id, and leaves the first one intact", async () => {
    // plugin-a: LINKED (the working copy set up in beforeEach), contributing "linked-plugin".
    const installedA = await ctx.extensions.install({
      source: workingCopy,
      id: "linked-plugin",
    })
    expect(installedA.ok).toBe(true)
    await ctx.refreshExtensions()

    // plugin-b: a DIFFERENT manifest id, installed in COPY mode, claiming the SAME
    // contribution id ("linked-plugin") that plugin-a already claims. An installer whose file
    // source can't see plugin-a (an empty link map at wiring time) would let this through —
    // the exact bug: `collectClaimedContributionIds` reads through the installer's OWN file
    // source, so if that source doesn't include plugin-a's link entry, plugin-a's claimed
    // contribution id is invisible to the duplicate check.
    const copySource = join(tmpRoot, "copy-source")
    await mkdir(copySource, { recursive: true })
    await writeFile(
      join(copySource, "spectrum-extension.json"),
      JSON.stringify(
        manifestWith({
          manifestId: "copy-plugin",
          contributionId: "linked-plugin",
          label: "Copy plugin",
        }),
        null,
        2,
      ),
      "utf8",
    )

    const installedB = await ctx.extensions.install({
      source: copySource,
      id: "copy-plugin",
      mode: "copy",
    })
    expect(installedB.ok).toBe(false)
    if (!installedB.ok) expect(installedB.error.kind).toBe("duplicate-id")

    // The rejected install must not have corrupted the first one: a refresh must still see
    // plugin-a's contribution rather than every plugin vanishing behind a `duplicate-id`
    // `registry.list()` failure (the actual failure mode before the file-source fix).
    await ctx.refreshExtensions()
    const key = pluginKeyOf(PluginIdSchema.parse("linked-plugin"))
    expect(ctx.providerRegistry.get(key)?.label).toBe("Linked v1")
  })
})
