import { describe, expect, it } from "bun:test"
import {
  type FfiModule,
  type RetainedHandle,
  __resetAvailabilityForTest,
  __retainedHandlesForTest,
  checkNativePtyAvailable,
  nativePtyAvailable,
} from "./native-availability"

// A minimal fake of the slice of `bun:ffi` that `checkNativePtyAvailable`
// consumes. `dlopen` returns a single sentinel "Library" handle; we track
// how many times it was called and keep the handle identity so we can
// assert it stays reachable.
const makeFakeFfi = (): {
  ffi: FfiModule
  handle: RetainedHandle
  dlopenCalls: () => number
} => {
  const handle = {
    symbols: { openpty: (): number => 0 },
    close: (): number => 0,
  }
  let calls = 0
  const ffi = {
    dlopen: (): typeof handle => {
      calls += 1
      return handle
    },
    // The probe only reads FFIType.ptr and FFIType.int to build the call
    // descriptor; the values themselves are unused.
    FFIType: { ptr: "ptr", int: "int" },
  } as unknown as FfiModule
  return {
    ffi,
    handle: handle as unknown as RetainedHandle,
    dlopenCalls: () => calls,
  }
}

describe("native-availability", () => {
  it("checkNativePtyAvailable sets the flag and returns a boolean without throwing", () => {
    const ok = checkNativePtyAvailable()
    expect(typeof ok).toBe("boolean")
    expect(nativePtyAvailable()).toBe(ok)
  })

  // REGRESSION: the parallel `dlopen` in `checkNativePtyAvailable` was missed by
  // the original `handles` retention fix (PR #94). The probe runs at GUI
  // composition on every launch and discards the handle, so its trampoline
  // becomes GC-eligible at startup — the next call branches into freed code and
  // crashes the bun sidecar with a PAC IB trap on arm64e. The probe MUST
  // retain the handle on a module-scoped anchor so it cannot be collected.
  it.skipIf(process.platform === "win32")(
    "retains the dlopen Library handle so its native trampoline can't be GC'd",
    () => {
      const { ffi, handle } = makeFakeFfi()
      // Clear any state from earlier tests so this test exercises the
      // injectable path end-to-end (memoization is a production concern).
      __resetAvailabilityForTest()

      const available = checkNativePtyAvailable(ffi)

      expect(available).toBe(true)
      expect(__retainedHandlesForTest()).toContain(handle)
    },
  )
})
