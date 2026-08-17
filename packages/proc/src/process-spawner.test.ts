import { describe, expect, it } from "bun:test"
import {
  createControllableProcessSpawner,
  createRecordingProcessSpawner,
} from "./process-spawner"

describe("createRecordingProcessSpawner", () => {
  it("records the command, args array, and env, and returns the configured pid with a resolved exited promise", async () => {
    const spawner = createRecordingProcessSpawner(4321)
    const r = spawner.spawn("/usr/local/bin/claude", [], {
      ANTHROPIC_API_KEY: "k",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.pid).toBe(4321)
    expect(await r.value.exited).toBe(0)
    expect(spawner.calls).toEqual([
      {
        command: "/usr/local/bin/claude",
        args: [],
        env: { ANTHROPIC_API_KEY: "k" },
      },
    ])
  })

  it("resolves exited with the configured exit code", async () => {
    const spawner = createRecordingProcessSpawner(7, 3)
    const r = spawner.spawn("/bin/false", [], {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(await r.value.exited).toBe(3)
  })

  it("preserves the args as an array so callers can assert no shell string was used", () => {
    const spawner = createRecordingProcessSpawner(1)
    spawner.spawn("/bin/echo", ["hello", "world"], {})
    expect(Array.isArray(spawner.calls[0]?.args)).toBe(true)
    expect(spawner.calls[0]?.args).toEqual(["hello", "world"])
  })

  it("records the cwd passed to spawn", () => {
    const spawner = createRecordingProcessSpawner(7)
    spawner.spawn("/bin/echo", ["hi"], { A: "1" }, "/work/dir")
    expect(spawner.calls[0]?.cwd).toBe("/work/dir")
  })

  it("records undefined cwd when none is given", () => {
    const spawner = createRecordingProcessSpawner(7)
    spawner.spawn("/bin/echo", [], {})
    expect(spawner.calls[0]?.cwd).toBeUndefined()
  })

  it("records no kills before any spawned process is killed", () => {
    const spawner = createRecordingProcessSpawner(7)
    spawner.spawn("/bin/echo", [], {})
    expect(spawner.kills).toEqual([])
  })

  it("records the pid when a spawned process is killed", () => {
    const spawner = createRecordingProcessSpawner(7)
    const r = spawner.spawn("/bin/echo", [], {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.value.kill()
    expect(spawner.kills).toEqual([7])
  })

  it("gives each spawned process its own pid", () => {
    const spawner = createRecordingProcessSpawner(11)
    const a = spawner.spawn("/bin/a", [], {})
    const b = spawner.spawn("/bin/b", [], {})
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect([a.value.pid, b.value.pid]).toEqual([11, 12])
  })

  it("records each kill in call order when several processes are killed", () => {
    const spawner = createRecordingProcessSpawner(11)
    const a = spawner.spawn("/bin/a", [], {})
    const b = spawner.spawn("/bin/b", [], {})
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    b.value.kill()
    a.value.kill()
    expect(spawner.kills).toEqual([12, 11])
  })
})

describe("createControllableProcessSpawner", () => {
  it("leaves a spawned child running until the test exits it", async () => {
    const spawner = createControllableProcessSpawner()
    const r = spawner.spawn("/bin/server", [], {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    let exited = false
    void r.value.exited.then(() => {
      exited = true
    })
    await Promise.resolve()
    expect(exited).toBe(false)
    spawner.children[0]?.exit(7)
    expect(await r.value.exited).toBe(7)
  })

  it("gives each spawned child its own pid", () => {
    const spawner = createControllableProcessSpawner({ firstPid: 500 })
    spawner.spawn("/bin/a", [], {})
    spawner.spawn("/bin/b", [], {})
    expect(spawner.children.map((c) => c.pid)).toEqual([500, 501])
  })

  it("records the pid and exits the child when a spawned process is killed", async () => {
    const spawner = createControllableProcessSpawner({ firstPid: 500 })
    const r = spawner.spawn("/bin/a", [], {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.value.kill()
    expect(spawner.kills).toEqual([500])
    expect(await r.value.exited).toBe(143)
  })

  it("records the command, args array, and env of every spawn", () => {
    const spawner = createControllableProcessSpawner()
    spawner.spawn("/bin/a", ["--port", "1"], { K: "v" }, "/work")
    expect(spawner.calls).toEqual([
      {
        command: "/bin/a",
        args: ["--port", "1"],
        env: { K: "v" },
        cwd: "/work",
      },
    ])
  })

  it("returns the configured failure instead of spawning when one is given", () => {
    const spawner = createControllableProcessSpawner({
      failure: { kind: "spawn-failed", detail: "ENOENT" },
    })
    const r = spawner.spawn("/bin/a", [], {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toEqual({ kind: "spawn-failed", detail: "ENOENT" })
    expect(spawner.calls).toEqual([])
  })
})
