import { describe, expect, it } from "bun:test"
import { createRecordingProcessSpawner } from "./process-spawner"

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
})
