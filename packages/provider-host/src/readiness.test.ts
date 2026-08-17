import { describe, expect, it } from "bun:test"
import { waitForReady } from "./readiness"

const ticking = (step: number): (() => number) => {
  let t = 0
  return () => {
    const current = t
    t += step
    return current
  }
}

describe("waitForReady", () => {
  it("returns true when the probe succeeds with a matching token on the first attempt", async () => {
    const ready = await waitForReady(
      { probe: async () => ({ ok: true, token: "t1" }), sleep: async () => {} },
      {
        url: "http://127.0.0.1:9000/models",
        expectedToken: "t1",
        timeoutMs: 1000,
        now: () => 0,
      },
    )
    expect(ready).toBe(true)
  })

  it("keeps waiting when the probe answers with a mismatched token", async () => {
    let attempts = 0
    const ready = await waitForReady(
      {
        probe: async () => {
          attempts += 1
          return attempts >= 3
            ? { ok: true, token: "t1" }
            : { ok: true, token: "wrong" }
        },
        sleep: async () => {},
      },
      { url: "u", expectedToken: "t1", timeoutMs: 10_000, now: ticking(100) },
    )
    expect(ready).toBe(true)
    expect(attempts).toBe(3)
  })

  it("returns true regardless of token when no token is expected", async () => {
    const ready = await waitForReady(
      {
        probe: async () => ({ ok: true, token: undefined }),
        sleep: async () => {},
      },
      { url: "u", expectedToken: undefined, timeoutMs: 1000, now: () => 0 },
    )
    expect(ready).toBe(true)
  })

  it("returns true when the probe succeeds after several failures", async () => {
    let attempts = 0
    const ready = await waitForReady(
      {
        probe: async () => {
          attempts += 1
          return attempts >= 4
            ? { ok: true, token: "t1" }
            : { ok: false, token: undefined }
        },
        sleep: async () => {},
      },
      { url: "u", expectedToken: "t1", timeoutMs: 10_000, now: ticking(100) },
    )
    expect(ready).toBe(true)
    expect(attempts).toBe(4)
  })

  it("keeps waiting when the probe answers ok with no token at all", async () => {
    let attempts = 0
    const ready = await waitForReady(
      {
        probe: async () => {
          attempts += 1
          return { ok: true, token: undefined }
        },
        sleep: async () => {},
      },
      { url: "u", expectedToken: "t1", timeoutMs: 500, now: ticking(200) },
    )
    expect(ready).toBe(false)
    expect(attempts).toBeGreaterThan(1)
  })

  it("accepts the real plugin once it replaces a tokenless squatter's response", async () => {
    let attempts = 0
    const ready = await waitForReady(
      {
        probe: async () => {
          attempts += 1
          return attempts >= 3
            ? { ok: true, token: "t1" }
            : { ok: true, token: undefined }
        },
        sleep: async () => {},
      },
      { url: "u", expectedToken: "t1", timeoutMs: 10_000, now: ticking(100) },
    )
    expect(ready).toBe(true)
    expect(attempts).toBe(3)
  })

  it("returns false when the deadline passes before the probe succeeds", async () => {
    let attempts = 0
    const ready = await waitForReady(
      {
        probe: async () => {
          attempts += 1
          return { ok: false, token: undefined }
        },
        sleep: async () => {},
      },
      { url: "u", expectedToken: "t1", timeoutMs: 500, now: ticking(200) },
    )
    expect(ready).toBe(false)
    expect(attempts).toBeGreaterThan(0)
  })
})
