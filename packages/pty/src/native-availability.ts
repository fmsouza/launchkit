let available: boolean | null = null

/**
 * Probe whether a native PTY can be allocated under the current runtime.
 *
 * The PTY is built with libc `openpty(3)` via `bun:ffi` (see bun-ffi-pty.ts),
 * which is available on macOS + Linux but not Windows (no `openpty`; ConPTY
 * would be required). We probe by dlopen-ing the symbol — cheaper than spawning,
 * and it confirms `bun:ffi` + the library are usable before the manager commits
 * to the real terminal manager. Never throws.
 */
export const checkNativePtyAvailable = (): boolean => {
  if (available !== null) return available
  try {
    if (process.platform === "win32") {
      available = false
      return available
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
    const lib = process.platform === "darwin" ? "libutil.dylib" : "libutil.so.1"
    dlopen(lib, {
      openpty: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.int,
      },
    })
    available = true
  } catch {
    available = false
  }
  return available
}

export const nativePtyAvailable = (): boolean => available === true
