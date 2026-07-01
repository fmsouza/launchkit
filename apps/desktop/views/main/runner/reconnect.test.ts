import { describe, expect, it } from "bun:test"
import { backoffDelay, shouldForceReconnect, shouldReattach } from "./reconnect"

describe("backoffDelay", () => {
  it("grows with the attempt number", () => {
    expect(backoffDelay(0)).toBeLessThan(backoffDelay(1))
    expect(backoffDelay(1)).toBeLessThan(backoffDelay(2))
  })
  it("never falls below the base floor", () => {
    expect(backoffDelay(0)).toBeGreaterThanOrEqual(500)
  })
  it("caps at the max ceiling", () => {
    expect(backoffDelay(100)).toBe(10_000)
    expect(backoffDelay(100, { maxMs: 3_000 })).toBe(3_000)
  })
})

describe("shouldForceReconnect", () => {
  const base = { prevTickMs: 1_000, gapMs: 10_000, staleMs: 15_000 }
  it("is true when a wake-gap is detected and no frames arrived recently", () => {
    // 30s jump since last tick (wake), last frame 40s ago (stale)
    expect(
      shouldForceReconnect({ ...base, nowMs: 31_000, lastFrameMs: -9_000 }),
    ).toBe(true)
  })
  it("is false during active streaming even after a wake-gap", () => {
    // wake-gap present, but a frame arrived 1s ago → not stale
    expect(
      shouldForceReconnect({ ...base, nowMs: 31_000, lastFrameMs: 30_000 }),
    ).toBe(false)
  })
  it("is false without a wake-gap", () => {
    expect(
      shouldForceReconnect({ ...base, nowMs: 3_000, lastFrameMs: -100_000 }),
    ).toBe(false)
  })
})

describe("shouldReattach", () => {
  it("is true when returning to connected from reconnecting", () => {
    expect(shouldReattach("reconnecting", "connected")).toBe(true)
  })
  it("is false on the very first connect", () => {
    expect(shouldReattach("connecting", "connected")).toBe(false)
  })
  it("is false for any non-connected target", () => {
    expect(shouldReattach("connected", "reconnecting")).toBe(false)
  })
})
