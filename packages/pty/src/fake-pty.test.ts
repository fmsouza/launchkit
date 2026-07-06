import { describe, expect, it } from "bun:test"
import type { FakePtyHandle } from "./fake-pty"
import { createFakePtySpawner } from "./fake-pty"

const baseInput = {
  command: "/bin/zsh",
  args: ["-l"] as readonly string[],
  cwd: "/tmp",
  env: { TERM: "xterm-256color" },
  cols: 80,
  rows: 24,
}

describe("createFakePtySpawner", () => {
  it("returns an ok PtyHandle and records the spawn call", () => {
    const spawner = createFakePtySpawner()
    const r = spawner.spawn(baseInput)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]?.command).toBe("/bin/zsh")
  })

  it("emits a canned ANSI sequence on write via onData", () => {
    const spawner = createFakePtySpawner()
    const handle = spawner.spawn(baseInput)
    if (!handle.ok) throw new Error("spawn failed")
    const received: string[] = []
    handle.value.onData((bytes) =>
      received.push(new TextDecoder().decode(bytes)),
    )
    handle.value.write(new TextEncoder().encode("ls\r"))
    expect(received.join("")).toContain("$")
  })

  it("fires onExit with exitCode 0 on kill", () => {
    const spawner = createFakePtySpawner()
    const handle = spawner.spawn(baseInput)
    if (!handle.ok) throw new Error("spawn failed")
    const fakeHandle = handle.value as FakePtyHandle
    let exitCode = -1
    fakeHandle.onExit((code) => {
      exitCode = code
    })
    fakeHandle.kill()
    expect(exitCode).toBe(0)
  })

  it("records resize calls", () => {
    const spawner = createFakePtySpawner()
    const handle = spawner.spawn(baseInput)
    if (!handle.ok) throw new Error("spawn failed")
    const fakeHandle = handle.value as FakePtyHandle
    fakeHandle.resize(120, 40)
    expect(fakeHandle._resizeCalls).toEqual([{ cols: 120, rows: 40 }])
  })
})
