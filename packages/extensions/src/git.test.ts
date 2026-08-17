import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createFakeCommandResolver,
  createRecordingProcessSpawner,
} from "@spectrum/proc"
import { ok } from "@spectrum/utils"
import {
  createFsDirCopier,
  createInMemoryDirCopier,
  createProcessGitClient,
} from "./git"

const client = (opts?: { exitCode?: number; commit?: string }) => {
  const spawner = createRecordingProcessSpawner(4242, opts?.exitCode ?? 0)
  const git = createProcessGitClient({
    resolver: createFakeCommandResolver({ git: "/usr/bin/git" }, "macos"),
    spawner,
    capture: async () => ok(opts?.commit ?? "abc123\n"),
  })
  return { git, spawner }
}

describe("createProcessGitClient", () => {
  it("spawns git clone with an argument array when cloning", async () => {
    const { git, spawner } = client()
    const r = await git.clone("https://example.com/a.git", "/data/providers/a")
    expect(r.ok).toBe(true)
    expect(spawner.calls[0]?.command).toBe("/usr/bin/git")
    expect(spawner.calls[0]?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--",
      "https://example.com/a.git",
      "/data/providers/a",
    ])
  })

  it("passes the ref as a branch argument when a ref is supplied", async () => {
    const { git, spawner } = client()
    await git.clone("https://example.com/a.git", "/data/providers/a", "v1.2.3")
    expect(spawner.calls[0]?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "v1.2.3",
      "--",
      "https://example.com/a.git",
      "/data/providers/a",
    ])
  })

  it("puts -- before the url/dest positionals so a leading-dash url can't be parsed as a git option", async () => {
    const { git, spawner } = client()
    await git.clone("https://example.com/a.git", "/data/providers/a")
    expect(spawner.calls[0]?.args).toContain("--")
    const dashIndex = spawner.calls[0]?.args.indexOf("--") ?? -1
    const urlIndex = spawner.calls[0]?.args.indexOf("https://example.com/a.git")
    expect(dashIndex).toBeGreaterThanOrEqual(0)
    expect(urlIndex).toBeGreaterThan(dashIndex)
  })

  it("never interpolates the url into a shell string", async () => {
    const { git, spawner } = client()
    await git.clone("https://example.com/a.git; rm -rf /", "/data/providers/a")
    expect(spawner.calls[0]?.args).toContain(
      "https://example.com/a.git; rm -rf /",
    )
    expect(spawner.calls[0]?.command).toBe("/usr/bin/git")
  })

  it("fails with git-failed when the clone exits non-zero", async () => {
    const { git } = client({ exitCode: 128 })
    const r = await git.clone("https://example.com/a.git", "/data/providers/a")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("git-failed")
  })

  it("fails with git-failed when git is not on PATH", async () => {
    const spawner = createRecordingProcessSpawner(1)
    const git = createProcessGitClient({
      resolver: createFakeCommandResolver({}, "macos"),
      spawner,
      capture: async () => ok("abc123"),
    })
    const r = await git.clone("https://example.com/a.git", "/data/providers/a")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("git-failed")
    expect(spawner.calls.length).toBe(0)
  })

  it("fetches the pinned ref inside the extension directory without touching the working tree", async () => {
    const { git, spawner } = client()
    const r = await git.fetch("/data/providers/a", "v2")
    expect(r.ok).toBe(true)
    expect(spawner.calls.map((c) => c.args)).toEqual([
      ["fetch", "--depth", "1", "--", "origin", "v2"],
    ])
    expect(spawner.calls[0]?.cwd).toBe("/data/providers/a")
  })

  it("checks out the fetched commit as its own separate operation", async () => {
    const { git, spawner } = client()
    const r = await git.checkoutFetchHead("/data/providers/a")
    expect(r.ok).toBe(true)
    expect(spawner.calls.map((c) => c.args)).toEqual([
      ["checkout", "FETCH_HEAD"],
    ])
    expect(spawner.calls[0]?.cwd).toBe("/data/providers/a")
  })

  it("reads a file out of the fetched commit without checking anything out", async () => {
    const captured: { args?: readonly string[]; cwd?: string } = {}
    const spawner = createRecordingProcessSpawner(4242, 0)
    const git = createProcessGitClient({
      resolver: createFakeCommandResolver({ git: "/usr/bin/git" }, "macos"),
      spawner,
      capture: async (_command, args, cwd) => {
        captured.args = args
        captured.cwd = cwd
        return ok('{"id":"a"}')
      },
    })
    const r = await git.showFetchHead("/data/providers/a", "manifest.json")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('{"id":"a"}')
    expect(captured.args).toEqual(["show", "FETCH_HEAD:manifest.json"])
    expect(captured.cwd).toBe("/data/providers/a")
    // Nothing was spawned through the mutating path — reading a candidate must never write.
    expect(spawner.calls.length).toBe(0)
  })

  it("puts -- before origin/ref in fetch so a leading-dash ref can't be parsed as a git option", async () => {
    const { git, spawner } = client()
    await git.fetch("/data/providers/a", "--upload-pack=touch /tmp/pwned")
    const fetchArgs = spawner.calls[0]?.args ?? []
    expect(fetchArgs).toContain("--")
    const dashIndex = fetchArgs.indexOf("--")
    const refIndex = fetchArgs.indexOf("--upload-pack=touch /tmp/pwned")
    expect(dashIndex).toBeGreaterThanOrEqual(0)
    expect(refIndex).toBeGreaterThan(dashIndex)
  })

  it("returns the trimmed commit sha when rev-parsing", async () => {
    const { git } = client({ commit: "  deadbeef\n" })
    const r = await git.revParse("/data/providers/a")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("deadbeef")
  })

  it("never leaks embedded url credentials into a git-failed detail", async () => {
    const { git } = client({ exitCode: 128 })
    const r = await git.clone(
      "https://alice:s3cr3t@example.com/a.git",
      "/data/providers/a",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("git-failed")
      expect(JSON.stringify(r.error)).not.toContain("s3cr3t")
      expect(JSON.stringify(r.error)).not.toContain("alice:s3cr3t@")
    }
  })

  it("forces askpass/proxy-command empty and the terminal prompt off on every spawn", async () => {
    const { git, spawner } = client()
    await git.clone("https://example.com/a.git", "/data/providers/a")
    const env = spawner.calls[0]?.env
    expect(env?.GIT_ASKPASS).toBe("")
    expect(env?.SSH_ASKPASS).toBe("")
    expect(env?.GIT_PROXY_COMMAND).toBe("")
    expect(env?.GIT_TERMINAL_PROMPT).toBe("0")
  })
})

describe("createInMemoryDirCopier", () => {
  it("reports the destination as existing after a copy", async () => {
    const copier = createInMemoryDirCopier(["/src/a"])
    expect(await copier.exists("/data/providers/a")).toBe(false)
    const r = await copier.copy("/src/a", "/data/providers/a")
    expect(r.ok).toBe(true)
    expect(await copier.exists("/data/providers/a")).toBe(true)
  })

  it("records what it copied so a test can assert nothing was written", async () => {
    const copier = createInMemoryDirCopier(["/src/a"])
    await copier.copy("/src/a", "/data/providers/a")
    expect(copier.copies).toEqual([{ from: "/src/a", to: "/data/providers/a" }])
  })

  it("fails with read-failed when the source does not exist", async () => {
    const copier = createInMemoryDirCopier([])
    const r = await copier.copy("/src/missing", "/data/providers/a")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })
})

describe("createFsDirCopier", () => {
  const tmpDirs: string[] = []

  const makeTmpDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "spectrum-dircopier-"))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it("copies a directory tree's contents to the destination", async () => {
    const root = await makeTmpDir()
    const src = join(root, "src")
    const dest = join(root, "dest")
    await mkdir(src, { recursive: true })
    await mkdir(join(src, "nested"), { recursive: true })
    await writeFile(join(src, "file.txt"), "hello")
    await writeFile(join(src, "nested", "inner.txt"), "world")

    const copier = createFsDirCopier()
    const r = await copier.copy(src, dest)
    expect(r.ok).toBe(true)
    expect(await readFile(join(dest, "file.txt"), "utf8")).toBe("hello")
    expect(await readFile(join(dest, "nested", "inner.txt"), "utf8")).toBe(
      "world",
    )
  })

  it("fails with read-failed when copying a directory into itself", async () => {
    const root = await makeTmpDir()
    await mkdir(root, { recursive: true })

    const copier = createFsDirCopier()
    const r = await copier.copy(root, root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })

  it("fails with read-failed when copying a directory into its own descendant", async () => {
    const root = await makeTmpDir()
    await mkdir(root, { recursive: true })
    const child = join(root, "child")

    const copier = createFsDirCopier()
    const r = await copier.copy(root, child)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })

  it("fails with read-failed when the self-copy is disguised with a .. segment", async () => {
    const root = await makeTmpDir()
    const sub = join(root, "sub")
    await mkdir(sub, { recursive: true })
    // Built with raw string concatenation, NOT `path.join`/`path.normalize` — `join` would
    // collapse `..` itself and defeat the point of this test. `${sub}/..` is lexically
    // distinct from `root` but resolves (via `path.resolve`) to the exact same directory —
    // a genuine self-copy that a plain string-prefix check on the raw strings would miss.
    const disguisedFrom = `${sub}/..`

    const copier = createFsDirCopier()
    const r = await copier.copy(disguisedFrom, root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
  })

  it("reports a directory as not existing (ENOENT) as false", async () => {
    const root = await makeTmpDir()
    const copier = createFsDirCopier()
    expect(await copier.exists(join(root, "missing"))).toBe(false)
  })

  it("reports a directory that exists as true", async () => {
    const root = await makeTmpDir()
    const dir = join(root, "present")
    await mkdir(dir, { recursive: true })
    const copier = createFsDirCopier()
    expect(await copier.exists(dir)).toBe(true)
  })
})
