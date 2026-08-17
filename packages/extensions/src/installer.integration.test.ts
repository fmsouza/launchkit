import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInstall } from "@spectrum/config"
import {
  createBunProcessSpawner,
  createPathCommandResolver,
} from "@spectrum/proc"
import { PluginIdSchema } from "@spectrum/types"
import {
  createBunCaptureStdout,
  createDirExtensionFileSource,
} from "./adapters"
import { createFsReadManifest } from "./adapters"
import { createFsDirCopier, createProcessGitClient } from "./git"
import { type ExtensionInstaller, createExtensionInstaller } from "./installer"
import { MANIFEST_FILE } from "./manifest"
import { createExtensionRegistry } from "./registry"

/**
 * `update` against REAL git. The failure this pins is not reachable with a fake client: a
 * fake's `fetchCheckout` cannot leave a bad manifest in a working tree, so a refused update
 * that had already adopted the new commit looked identical to one that had not. On disk it
 * bricked the whole installed set — `registry.list()` batch-fails on a duplicate id, so every
 * extension vanished from the catalog, the CLI and the GUI, and `update` could not recover it
 * (the recorded ref is unchanged, so it re-fetches the same commit).
 */

const pid = (id: string) => PluginIdSchema.parse(id)

const manifest = (id: string, contributionId: string): string =>
  `${JSON.stringify(
    {
      apiVersion: "spectrum.dev/v1",
      id,
      name: `Acme ${id}`,
      version: "1.0.0",
      contributes: {
        providers: [
          {
            id: contributionId,
            descriptor: {
              label: `Acme ${contributionId}`,
              secretFields: [
                { name: "apiKey", label: "API key", required: true },
              ],
              reasoning: { shape: "none", supportedTiers: [] },
              discovery: { strategy: "openai-models" },
            },
            transport: { kind: "http", wire: "openai" },
          },
        ],
      },
    },
    null,
    2,
  )}\n`

const git = async (cwd: string, ...args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

let root: string
let origin: string
let pluginRoot: string
let installer: ExtensionInstaller
let victimInstall: PluginInstall

const gitClient = () =>
  createProcessGitClient({
    resolver: createPathCommandResolver(),
    spawner: createBunProcessSpawner(),
    capture: createBunCaptureStdout(),
  })

const fileSource = () => createDirExtensionFileSource(pluginRoot, {})

const readInstalledManifest = async (id: string): Promise<string> =>
  readFile(join(pluginRoot, id, MANIFEST_FILE), "utf8")

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spectrum-installer-int-"))
  origin = join(root, "origin")
  pluginRoot = join(root, "plugins")
  await mkdir(origin, { recursive: true })
  await mkdir(pluginRoot, { recursive: true })

  await git(origin, "init", "--initial-branch=main", ".")
  await git(origin, "config", "user.email", "test@spectrum.invalid")
  await git(origin, "config", "user.name", "Spectrum Test")
  await git(origin, "config", "commit.gpgsign", "false")
  await writeFile(join(origin, MANIFEST_FILE), manifest("victim", "victim-api"))
  await git(origin, "add", "-A")
  await git(origin, "commit", "-m", "v1")

  // A neighbour already claiming the contribution id the bad upstream commit will collide on.
  await mkdir(join(pluginRoot, "neighbour"), { recursive: true })
  await writeFile(
    join(pluginRoot, "neighbour", MANIFEST_FILE),
    manifest("neighbour", "shared-api"),
  )

  const client = gitClient()
  const cloned = await client.clone(origin, join(pluginRoot, "victim"))
  if (!cloned.ok) throw new Error("fixture clone failed")
  const commit = await client.revParse(join(pluginRoot, "victim"))
  if (!commit.ok) throw new Error("fixture rev-parse failed")

  victimInstall = {
    id: pid("victim"),
    source: { kind: "git", url: origin, ref: "HEAD", commit: commit.value },
    enabled: true,
  }

  installer = createExtensionInstaller({
    git: client,
    copier: createFsDirCopier(),
    fileSource: fileSource(),
    readManifest: createFsReadManifest(),
    pluginRoot,
    existingInstalls: () => [victimInstall],
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("ExtensionInstaller.update against real git", () => {
  it("adopts the new commit when the fetched manifest is valid", async () => {
    await writeFile(
      join(origin, MANIFEST_FILE),
      manifest("victim", "victim-api-v2"),
    )
    await git(origin, "add", "-A")
    await git(origin, "commit", "-m", "v2")

    const r = await installer.update(pid("victim"), victimInstall)
    expect(r.ok).toBe(true)
    expect(await readInstalledManifest("victim")).toContain("victim-api-v2")
    if (r.ok && r.value.install.source.kind === "git")
      expect(r.value.install.source.commit).not.toBe(
        victimInstall.source.kind === "git"
          ? victimInstall.source.commit
          : undefined,
      )
  })

  it("leaves the old manifest checked out when the fetched manifest collides with another extension", async () => {
    await writeFile(
      join(origin, MANIFEST_FILE),
      manifest("victim", "shared-api"),
    )
    await git(origin, "add", "-A")
    await git(origin, "commit", "-m", "colliding v2")

    const r = await installer.update(pid("victim"), victimInstall)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")

    const onDisk = await readInstalledManifest("victim")
    expect(onDisk).toContain("victim-api")
    expect(onDisk).not.toContain("shared-api")

    // The whole point: a refused update must not brick every OTHER installed extension.
    const listed = await createExtensionRegistry({
      fileSource: fileSource(),
    }).list()
    expect(listed.ok).toBe(true)
    if (listed.ok)
      expect(listed.value.map((e) => String(e.manifest.id)).sort()).toEqual([
        "neighbour",
        "victim",
      ])
  })

  it("leaves the old manifest checked out when the fetched manifest is unparseable", async () => {
    await writeFile(join(origin, MANIFEST_FILE), "{ not json")
    await git(origin, "add", "-A")
    await git(origin, "commit", "-m", "broken v2")

    const r = await installer.update(pid("victim"), victimInstall)
    expect(r.ok).toBe(false)

    expect(await readInstalledManifest("victim")).toContain("victim-api")
    const listed = await createExtensionRegistry({
      fileSource: fileSource(),
    }).list()
    expect(listed.ok).toBe(true)
  })

  it("leaves the old manifest checked out when the fetched manifest needs a newer api version", async () => {
    await writeFile(
      join(origin, MANIFEST_FILE),
      manifest("victim", "victim-api").replace(
        "spectrum.dev/v1",
        "spectrum.dev/v99",
      ),
    )
    await git(origin, "add", "-A")
    await git(origin, "commit", "-m", "future v2")

    const r = await installer.update(pid("victim"), victimInstall)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-api-version")

    expect(await readInstalledManifest("victim")).toContain("spectrum.dev/v1")
  })
})
