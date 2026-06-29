/**
 * The slice of `bun:ffi` that {@link checkNativePtyAvailable} consumes
 * (injectable for tests, mirroring the shape used by `loadNative` in
 * `bun-ffi-pty.ts`).
 */
export type FfiModule = Pick<typeof import("bun:ffi"), "dlopen" | "FFIType">

/**
 * The shape of a single retained `dlopen` Library handle. The probe never
 * invokes it; the reference exists purely to anchor the handle against
 * garbage collection.
 */
export type RetainedHandle = unknown

/**
 * Retained `dlopen` Library handles from the availability probe. `bun:ffi`
 * compiles a per-symbol native trampoline owned by the Library handle; if
 * that handle is garbage collected the trampoline memory is freed, and the
 * next call to a symbol branches into freed code — on arm64e (Apple
 * Silicon) that surfaces as a pointer-authentication trap (PAC IB) and a
 * hard process crash. The probe runs at GUI composition on every launch,
 * so keeping the handle reachable here prevents the crash trigger that
 * bit `Spectrum-dev.app` on 2026-06-29.
 *
 * Never iterated, never invoked. The array exists purely to anchor the
 * references.
 */
const retainedHandles: RetainedHandle[] = []

/**
 * Test-only inspector for the retention anchor. Production code MUST NOT
 * read this — the array is an implementation detail of the GC anchor.
 */
export const __retainedHandlesForTest = (): readonly RetainedHandle[] =>
  retainedHandles

let available: boolean | null = null

/**
 * Test-only reset hook for the memoized `available` flag and the retention
 * anchor. Production code MUST NOT call this — the memoization is intentional.
 */
export const __resetAvailabilityForTest = (): void => {
  available = null
  retainedHandles.length = 0
}

/**
 * Probe whether a native PTY can be allocated under the current runtime.
 *
 * The PTY is built with libc `openpty(3)` via `bun:ffi` (see bun-ffi-pty.ts),
 * which is available on macOS + Linux but not Windows (no `openpty`; ConPTY
 * would be required). We probe by dlopen-ing the symbol — cheaper than spawning,
 * and it confirms `bun:ffi` + the library are usable before the manager commits
 * to the real terminal manager. Never throws.
 *
 * The `dlopen` Library handle is retained on a module-scoped anchor (see
 * `__retainedHandlesForTest`) so the probe's native trampoline cannot be GC'd
 * while its result is still observable — fixes the parallel bug to PR #94's
 * `loadNative` fix.
 */
export const checkNativePtyAvailable = (
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ffi: FfiModule = require("bun:ffi") as FfiModule,
): boolean => {
  if (available !== null) return available
  try {
    if (process.platform === "win32") {
      available = false
      return available
    }
    const { dlopen, FFIType } = ffi
    const lib = process.platform === "darwin" ? "libutil.dylib" : "libutil.so.1"
    const handle = dlopen(lib, {
      openpty: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.int,
      },
    })
    // Anchor the handle against GC — see `retainedHandles` JSDoc above.
    retainedHandles.push(handle)
    available = true
  } catch {
    available = false
  }
  return available
}

export const nativePtyAvailable = (): boolean => available === true
