import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createBunProcessSpawner,
  createPathCommandResolver,
} from "@spectrum/proc"
import { createBunCaptureStdout } from "./adapters"
import { type GitClient, createProcessGitClient } from "./git"

/**
 * The one place in this package that runs REAL git. Every other git test asserts the argv
 * shape against a recording spawner or a fake client, which cannot tell a ref git accepts
 * from one it rejects — that blind spot is exactly how `clone --branch HEAD` (fatal: `HEAD`
 * is a symref, not a name under `refs/heads`/`refs/tags`) shipped while every test passed.
 */

const gitClient = (): GitClient =>
  createProcessGitClient({
    resolver: createPathCommandResolver(),
    spawner: createBunProcessSpawner(),
    capture: createBunCaptureStdout(),
  })

let root: string
let origin: string

/** `git -C` + an argument array; throws on failure so a broken fixture is loud. */
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

const commitFile = async (
  repo: string,
  name: string,
  contents: string,
  message: string,
): Promise<void> => {
  await writeFile(join(repo, name), contents)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-m", message)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spectrum-git-int-"))
  origin = join(root, "origin")
  await mkdir(origin, { recursive: true })
  await git(origin, "init", "--initial-branch=main", ".")
  await git(origin, "config", "user.email", "test@spectrum.invalid")
  await git(origin, "config", "user.name", "Spectrum Test")
  await git(origin, "config", "commit.gpgsign", "false")
  await commitFile(origin, "spectrum-extension.json", '{"v":1}', "first")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("createProcessGitClient against real git", () => {
  it("clones the default branch when no ref is requested", async () => {
    const dest = join(root, "clone-default")
    const r = await gitClient().clone(origin, dest)
    expect(r.ok).toBe(true)
    expect(await readFile(join(dest, "spectrum-extension.json"), "utf8")).toBe(
      '{"v":1}',
    )
  })

  it("clones a real branch name when one is requested", async () => {
    await git(origin, "checkout", "-b", "next")
    await commitFile(origin, "spectrum-extension.json", '{"v":2}', "second")
    await git(origin, "checkout", "main")

    const dest = join(root, "clone-branch")
    const r = await gitClient().clone(origin, dest, "next")
    expect(r.ok).toBe(true)
    expect(await readFile(join(dest, "spectrum-extension.json"), "utf8")).toBe(
      '{"v":2}',
    )
  })

  /** The recorded ref of a default-branch install is `"HEAD"`, and `fetch` accepts it — but
   * `clone --branch` does not. This case is why the installer must not forward the recorded
   * value into the clone; it fails against real git and cannot fail against a fake. */
  it("cannot clone --branch HEAD, so HEAD must never reach a clone", async () => {
    const dest = join(root, "clone-head")
    const r = await gitClient().clone(origin, dest, "HEAD")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("git-failed")
  })

  it("resolves the cloned commit with rev-parse", async () => {
    const dest = join(root, "clone-rev")
    await gitClient().clone(origin, dest)
    const r = await gitClient().revParse(dest)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatch(/^[0-9a-f]{40}$/)
  })

  it("fetches HEAD, reads the candidate file out of FETCH_HEAD, and only then checks it out", async () => {
    const dest = join(root, "clone-update")
    await gitClient().clone(origin, dest)
    await commitFile(origin, "spectrum-extension.json", '{"v":9}', "upstream")

    const client = gitClient()
    const fetched = await client.fetch(dest, "HEAD")
    expect(fetched.ok).toBe(true)

    const shown = await client.showFetchHead(dest, "spectrum-extension.json")
    expect(shown.ok).toBe(true)
    if (shown.ok) expect(shown.value.trim()).toBe('{"v":9}')

    // The fetch alone left the working tree on the OLD commit — that is the property the
    // installer relies on to validate a candidate manifest before adopting it.
    expect(await readFile(join(dest, "spectrum-extension.json"), "utf8")).toBe(
      '{"v":1}',
    )

    const checkedOut = await client.checkoutFetchHead(dest)
    expect(checkedOut.ok).toBe(true)
    expect(await readFile(join(dest, "spectrum-extension.json"), "utf8")).toBe(
      '{"v":9}',
    )
  })

  it("fails with git-failed when the fetched tree holds no such file", async () => {
    const dest = join(root, "clone-missing")
    await gitClient().clone(origin, dest)
    const client = gitClient()
    await client.fetch(dest, "HEAD")
    const shown = await client.showFetchHead(dest, "nope.json")
    expect(shown.ok).toBe(false)
    if (!shown.ok) expect(shown.error.kind).toBe("git-failed")
  })
})
