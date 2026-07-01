import { describe, expect, it } from "bun:test"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStartWatchdog } from "./useStartWatchdog"

describe("useStartWatchdog", () => {
  it("re-attaches after the reattach delay while active", async () => {
    let reattaches = 0
    renderHook(() =>
      useStartWatchdog({
        active: true,
        reattach: () => {
          reattaches += 1
        },
        reattachDelayMs: 10,
        failDelayMs: 10_000,
      }),
    )
    await waitFor(() => expect(reattaches).toBe(1))
  })

  it("marks failed after the fail delay while still active", async () => {
    const { result } = renderHook(() =>
      useStartWatchdog({
        active: true,
        reattach: () => {},
        reattachDelayMs: 5,
        failDelayMs: 15,
      }),
    )
    expect(result.current.failed).toBe(false)
    await waitFor(() => expect(result.current.failed).toBe(true))
  })

  it("clears timers and resets failed once active becomes false", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useStartWatchdog({
          active,
          reattach: () => {},
          reattachDelayMs: 5,
          failDelayMs: 15,
        }),
      { initialProps: { active: true } },
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    rerender({ active: false })
    expect(result.current.failed).toBe(false)
  })

  it("retry() re-attaches immediately and clears failed", async () => {
    let reattaches = 0
    const { result } = renderHook(() =>
      useStartWatchdog({
        active: true,
        reattach: () => {
          reattaches += 1
        },
        reattachDelayMs: 5,
        failDelayMs: 10,
      }),
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    act(() => result.current.retry())
    expect(result.current.failed).toBe(false)
    expect(reattaches).toBeGreaterThanOrEqual(2) // scheduled reattach + manual retry
  })
})
