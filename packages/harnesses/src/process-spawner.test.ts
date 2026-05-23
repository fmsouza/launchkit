import { describe, expect, it } from "bun:test"
import { createRecordingProcessSpawner } from "./process-spawner"

describe("createRecordingProcessSpawner", () => {
  it("records the command, args array, and env, and returns the configured pid", () => {
    const spawner = createRecordingProcessSpawner(4321)
    const r = spawner.spawn("/usr/local/bin/claude", [], {
      ANTHROPIC_API_KEY: "k",
    })
    expect(r).toEqual({ ok: true, value: { pid: 4321 } })
    expect(spawner.calls).toEqual([
      {
        command: "/usr/local/bin/claude",
        args: [],
        env: { ANTHROPIC_API_KEY: "k" },
      },
    ])
  })

  it("preserves the args as an array so callers can assert no shell string was used", () => {
    const spawner = createRecordingProcessSpawner(1)
    spawner.spawn("/bin/echo", ["hello", "world"], {})
    expect(Array.isArray(spawner.calls[0]?.args)).toBe(true)
    expect(spawner.calls[0]?.args).toEqual(["hello", "world"])
  })
})
