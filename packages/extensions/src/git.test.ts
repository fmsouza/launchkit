import { describe, expect, it } from "bun:test"
import {
  createFakeCommandResolver,
  createRecordingProcessSpawner,
} from "@spectrum/proc"
import { ok } from "@spectrum/utils"
import { createInMemoryDirCopier, createProcessGitClient } from "./git"

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
      "https://example.com/a.git",
      "/data/providers/a",
    ])
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

  it("checks out the pinned ref inside the extension directory when updating", async () => {
    const { git, spawner } = client()
    const r = await git.fetchCheckout("/data/providers/a", "v2")
    expect(r.ok).toBe(true)
    expect(spawner.calls.map((c) => c.args)).toEqual([
      ["fetch", "--depth", "1", "origin", "v2"],
      ["checkout", "FETCH_HEAD"],
    ])
    expect(spawner.calls[0]?.cwd).toBe("/data/providers/a")
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
