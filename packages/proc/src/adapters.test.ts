import { afterEach, describe, expect, it } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBunProcessSpawner, createPathCommandResolver } from "./adapters"

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lk-harness-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("createPathCommandResolver (real)", () => {
  // POSIX-only: `Bun.which("true")` resolves to `/usr/bin/true` on macOS/Linux
  // but `true` isn't a real on-PATH command on Windows.
  it.skipIf(process.platform === "win32")(
    "resolves a real on-PATH command to an absolute path",
    () => {
      const r = createPathCommandResolver().resolve("true")
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.startsWith("/")).toBe(true)
    },
  )

  it("rejects a relative command without touching PATH", () => {
    const r = createPathCommandResolver().resolve("./nope")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-command")
  })

  // POSIX-only: writes a real executable into a temp dir and mutates PATH so
  // only that temp dir is on PATH — verifying the resolver searches the LIVE
  // process.env.PATH (which GUI startup enrichment rebuilds) rather than
  // Bun's startup PATH snapshot (which is minimal in a packaged Finder-launched app).
  it.skipIf(process.platform === "win32")(
    "resolves a command found only on the LIVE process.env.PATH, not the startup PATH snapshot",
    () => {
      const dir = makeTempDir()
      const bin = "spectrum-which-probe-bin"
      writeFileSync(join(dir, bin), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

      const savedPath = process.env.PATH
      try {
        process.env.PATH = dir
        const r = createPathCommandResolver().resolve(bin)
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(realpathSync(r.value)).toBe(realpathSync(join(dir, bin)))
        }
      } finally {
        process.env.PATH = savedPath
      }
    },
  )
})

describe("createBunProcessSpawner (real)", () => {
  // POSIX-only: depends on `true` resolving to a real on-PATH command
  // (it isn't on Windows).
  it.skipIf(process.platform === "win32")(
    "spawns a harmless command and returns a numeric pid",
    () => {
      const resolver = createPathCommandResolver()
      const resolved = resolver.resolve("true")
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return

      const r = createBunProcessSpawner().spawn(resolved.value, [], {})
      expect(r.ok).toBe(true)
      if (r.ok) expect(typeof r.value.pid).toBe("number")
    },
  )

  it("inherits the parent env and lets rendered vars override inherited ones", async () => {
    const dir = makeTempDir()
    const outFile = join(dir, "env.json")

    // A marker present in the PARENT env; the child should be able to override it.
    const priorMarker = process.env.LK_SPAWN_MARKER
    process.env.LK_SPAWN_MARKER = "parent-value"
    try {
      const r = createBunProcessSpawner().spawn(
        process.execPath,
        [
          "-e",
          "require('fs').writeFileSync(process.env.LK_OUT, JSON.stringify({ marker: process.env.LK_SPAWN_MARKER, hasPath: Boolean(process.env.PATH) }))",
        ],
        { LK_OUT: outFile, LK_SPAWN_MARKER: "override-value" },
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      await r.value.exited

      const captured = JSON.parse(readFileSync(outFile, "utf8")) as {
        marker: string
        hasPath: boolean
      }
      // Rendered/override vars WIN over inherited ones (proxy key authority).
      expect(captured.marker).toBe("override-value")
      // ... while the rest of the parent env (PATH) is still inherited.
      expect(captured.hasPath).toBe(true)
    } finally {
      if (priorMarker === undefined) {
        process.env.LK_SPAWN_MARKER = ""
      } else {
        process.env.LK_SPAWN_MARKER = priorMarker
      }
    }
  })

  // POSIX-only: uses `/bin/sh -c`, which doesn't exist on Windows.
  it.skipIf(process.platform === "win32")(
    "spawns the child process in the given cwd",
    async () => {
      const dir = makeTempDir()
      const out = join(dir, "where.txt")
      const spawner = createBunProcessSpawner()
      // Write the child's cwd to a file (stdio is inherited, so assert via the filesystem).
      const r = spawner.spawn(
        "/bin/sh",
        ["-c", `pwd -P > ${out}`],
        { ...process.env } as Record<string, string>,
        dir,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      await r.value.exited
      const written = readFileSync(out, "utf8").trim()
      expect(written).toBe(realpathSync(dir))
    },
  )
})
