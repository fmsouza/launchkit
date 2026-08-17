import { describe, expect, it } from "bun:test"
import { type DrainWait, type QuitEvent, createQuitGate } from "./quit-gate"

/**
 * A fully manual `DrainWait`: no real timers, so no test waits on wall-clock, and a test can fire
 * the cap deliberately. Records cleared handles so a test can prove the timer is not leaked when
 * shutdown wins the race.
 */
const makeManualWait = (capMs = 2000) => {
  const scheduled: { handle: number; fn: () => void }[] = []
  const cleared: number[] = []
  let next = 1
  const wait: DrainWait = {
    capMs,
    setTimeout: (fn) => {
      const handle = next++
      scheduled.push({ handle, fn })
      return handle
    },
    clearTimeout: (handle) => {
      cleared.push(handle as number)
    },
  }
  return {
    wait,
    cleared,
    fireCap: (): void => {
      const entry = scheduled.shift()
      if (entry === undefined) throw new Error("no cap timer was scheduled")
      entry.fn()
    },
  }
}

/** A stand-in for the Electrobun `before-quit` event: only the veto response matters here. */
const quitEvent = (): QuitEvent & {
  readonly seen: () => boolean | undefined
} => {
  const event: { response?: { allow: boolean } } = {}
  return {
    set response(value: { allow: boolean }) {
      event.response = value
    },
    seen: () => event.response?.allow,
  }
}

describe("createQuitGate", () => {
  it("vetoes the first quit request so the async shutdown can run to completion", () => {
    const gate = createQuitGate({
      shutdown: async () => {},
      quit: () => {},
      onShutdownFailed: () => {},
    })
    const event = quitEvent()
    gate(event)
    expect(event.seen()).toBe(false)
  })

  it("re-issues the quit once shutdown has settled", async () => {
    const order: string[] = []
    let release = (): void => {}
    const gate = createQuitGate({
      shutdown: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("shutdown")
            resolve()
          }
        }),
      quit: () => order.push("quit"),
      onShutdownFailed: () => {},
    })

    gate(quitEvent())
    expect(order).toEqual([])
    release()
    await Bun.sleep(0)
    expect(order).toEqual(["shutdown", "quit"])
  })

  it("lets the re-issued quit through instead of vetoing it again", async () => {
    let quits = 0
    const events: ReturnType<typeof quitEvent>[] = []
    const gate = createQuitGate({
      shutdown: async () => {},
      quit: () => {
        quits += 1
        const second = quitEvent()
        events.push(second)
        gate(second)
      },
      onShutdownFailed: () => {},
    })

    gate(quitEvent())
    await Bun.sleep(0)
    // Exactly one re-issue, and the second pass sets no veto — the app is free to exit.
    expect(quits).toBe(1)
    expect(events[0]?.seen()).toBeUndefined()
  })

  it("ignores a second quit request while the shutdown is still in flight", async () => {
    let shutdowns = 0
    const gate = createQuitGate({
      shutdown: async () => {
        shutdowns += 1
        await Bun.sleep(5)
      },
      quit: () => {},
      onShutdownFailed: () => {},
    })

    gate(quitEvent())
    const second = quitEvent()
    gate(second)
    await Bun.sleep(10)
    expect(shutdowns).toBe(1)
    expect(second.seen()).toBeUndefined()
  })

  it("quits anyway and reports the detail when shutdown rejects", async () => {
    const failures: string[] = []
    let quits = 0
    const gate = createQuitGate({
      shutdown: async () => {
        throw new Error("kill refused")
      },
      quit: () => {
        quits += 1
      },
      onShutdownFailed: (detail) => failures.push(detail),
    })

    gate(quitEvent())
    await Bun.sleep(0)
    expect(failures).toEqual(["kill refused"])
    expect(quits).toBe(1)
  })

  // `.catch`/`.finally` handle a REJECTED promise, not a PENDING one. A shutdown that never
  // settles would otherwise mean the re-quit never issues and Cmd+Q silently does nothing —
  // a worse outcome than a leaked child. Today `stopAll` cannot hang (its `stop` awaits nothing),
  // but awaiting `exited` or adding SIGKILL escalation is exactly what would make it hang.
  it("quits anyway when shutdown never settles", async () => {
    const manual = makeManualWait(2000)
    const failures: string[] = []
    let quits = 0
    const gate = createQuitGate(
      {
        shutdown: () => new Promise<void>(() => {}),
        quit: () => {
          quits += 1
        },
        onShutdownFailed: (detail) => failures.push(detail),
      },
      manual.wait,
    )

    gate(quitEvent())
    await Bun.sleep(0)
    expect(quits).toBe(0)

    manual.fireCap()
    expect(quits).toBe(1)
    expect(failures).toEqual(["shutdown did not settle within 2000ms"])
  })

  it("quits exactly once when shutdown settles after the cap already fired", async () => {
    const manual = makeManualWait(2000)
    let quits = 0
    let release = (): void => {}
    const gate = createQuitGate(
      {
        shutdown: () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
        quit: () => {
          quits += 1
        },
        onShutdownFailed: () => {},
      },
      manual.wait,
    )

    gate(quitEvent())
    manual.fireCap()
    release()
    await Bun.sleep(0)
    expect(quits).toBe(1)
  })

  it("clears the cap timer when shutdown wins the race", async () => {
    const manual = makeManualWait(2000)
    const gate = createQuitGate(
      {
        shutdown: async () => {},
        quit: () => {},
        onShutdownFailed: () => {},
      },
      manual.wait,
    )

    gate(quitEvent())
    await Bun.sleep(0)
    expect(manual.cleared).toEqual([1])
  })
})
