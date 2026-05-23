import { describe, it, expect, afterEach } from "bun:test"
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isOk } from "@launchkit/utils"
import { createFsConfigFile } from "./fs-config-file"

describe("createFsConfigFile (real filesystem)", () => {
  const dirs: string[] = []
  const freshDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "launchkit-config-"))
    dirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it("reports exists=false and returns not-found before anything is written", async () => {
    const file = createFsConfigFile(join(await freshDir(), "config.json"))
    expect(await file.exists()).toBe(false)
    expect(await file.read()).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("writes atomically, reads the contents back, and leaves no .tmp file behind", async () => {
    const path = join(await freshDir(), "config.json")
    const file = createFsConfigFile(path)

    const written = await file.writeAtomic('{"version":2}')
    expect(isOk(written)).toBe(true)
    expect(await file.exists()).toBe(true)
    expect(await file.read()).toEqual({ ok: true, value: '{"version":2}' })
    expect(await readFile(path, "utf8")).toBe('{"version":2}')

    // The temp file used during the atomic write must be gone after the rename.
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })

  it("sets 0600 permissions on the written file", async () => {
    const path = join(await freshDir(), "config.json")
    await createFsConfigFile(path).writeAtomic("{}")
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("returns parse-free raw bytes from read so the store owns JSON parsing", async () => {
    const path = join(await freshDir(), "config.json")
    await writeFile(path, "{ not json", "utf8")
    expect(await createFsConfigFile(path).read()).toEqual({ ok: true, value: "{ not json" })
  })
})
