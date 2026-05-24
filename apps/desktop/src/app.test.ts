import { describe, it, expect, mock } from "bun:test"
import { runApp } from "./app"
import type { RunAppDeps } from "./app"

/** A fully-faked RunAppDeps with spies, so a test can assert which path ran. */
const makeDeps = (over: Partial<RunAppDeps> = {}): RunAppDeps => ({
  runCli: mock(async (_argv: readonly string[]) => undefined),
  startProxy: mock((_ctx: unknown) => ({ stop: () => {} })),
  openWindow: mock(() => {}),
  ...over,
})

describe("runApp", () => {
  it("calls runCli with argv and never starts the proxy or opens a window when mode is 'cli'", async () => {
    const deps = makeDeps()
    const argv = ["bun", "main.ts", "launch", "claude"] as const

    await runApp("cli", argv, deps)

    expect(deps.runCli).toHaveBeenCalledTimes(1)
    expect((deps.runCli as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe(argv)
    expect(deps.startProxy).toHaveBeenCalledTimes(0)
    expect(deps.openWindow).toHaveBeenCalledTimes(0)
  })

  it("starts the proxy then opens the window and never runs the CLI when mode is 'gui'", async () => {
    const deps = makeDeps()

    await runApp("gui", ["bun", "main.ts"], deps)

    expect(deps.startProxy).toHaveBeenCalledTimes(1)
    expect(deps.openWindow).toHaveBeenCalledTimes(1)
    expect(deps.runCli).toHaveBeenCalledTimes(0)
  })

  it("starts the proxy before opening the window when mode is 'gui'", async () => {
    const order: string[] = []
    const deps = makeDeps({
      startProxy: mock(() => {
        order.push("startProxy")
        return { stop: () => {} }
      }),
      openWindow: mock(() => {
        order.push("openWindow")
      }),
    })

    await runApp("gui", ["bun", "main.ts"], deps)

    expect(order).toEqual(["startProxy", "openWindow"])
  })

  it("awaits runCli so a slow CLI command completes before runApp resolves", async () => {
    let finished = false
    const deps = makeDeps({
      runCli: mock(async () => {
        await Promise.resolve()
        finished = true
        return undefined
      }),
    })

    await runApp("cli", ["bun", "main.ts", "list"], deps)

    expect(finished).toBe(true)
  })
})
