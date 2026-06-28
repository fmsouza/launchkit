import type { Result } from "@spectrum/utils"
import type { TerminalError } from "./errors"
import type { PtyHandle, PtySpawner } from "./pty-adapter"

/**
 * A PtySpawner implemented with Bun-native primitives instead of node-pty.
 *
 * WHY: node-pty's native addon does not deliver PTY bytes under the Bun runtime
 * — `onData` never fires (verified on bun 1.3.x; the package's own smoke test
 * documents the same). Since the desktop app's main process runs under Bun, the
 * in-app terminal was permanently black with node-pty.
 *
 * HOW: allocate a pty with libc `openpty(3)` via `bun:ffi`, run the shell with
 * `Bun.spawn` wired to the slave fd, and stream the master fd with Bun's async
 * file IO (which DOES deliver pty-master bytes). Resize issues `TIOCSWINSZ` via
 * `ioctl(2)`. This is unix-only (macOS + Linux); Windows would need ConPTY and
 * is left to the no-op manager (`checkNativePtyAvailable()` returns false there).
 *
 * All Bun/Node-specific modules are loaded with a lazy `require` INSIDE `spawn`
 * (never a top-level import) so the browser/webview bundle — which imports this
 * package's barrel only for the pure protocol — never follows `bun:ffi`.
 */

// `TIOCSWINSZ` ioctl request number is platform-specific.
const TIOCSWINSZ_DARWIN = 0x80087467n
const TIOCSWINSZ_LINUX = 0x5414n

interface NativeBindings {
  openpty(
    amaster: NodeJS.TypedArray,
    aslave: NodeJS.TypedArray,
    name: null,
    termios: null,
    winsize: NodeJS.TypedArray,
  ): number
  ioctl(fd: number, request: bigint, argp: NodeJS.TypedArray): number
  tiocswinsz: bigint
}

/** dlopen libc/libutil for `openpty` + `ioctl`. Throws if the platform is unsupported. */
const loadNative = (): NativeBindings => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
  const platform = process.platform
  const openptyDef = {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  } as const
  const ioctlDef = {
    args: [FFIType.int, FFIType.u64, FFIType.ptr],
    returns: FFIType.int,
  } as const

  let openptyFn: NativeBindings["openpty"]
  let ioctlFn: NativeBindings["ioctl"]
  if (platform === "darwin") {
    // libutil.dylib re-exports libSystem, so one handle has both symbols.
    const lib = dlopen("libutil.dylib", {
      openpty: openptyDef,
      ioctl: ioctlDef,
    })
    openptyFn = lib.symbols.openpty as NativeBindings["openpty"]
    ioctlFn = lib.symbols.ioctl as NativeBindings["ioctl"]
  } else {
    // Linux: openpty in libutil, ioctl in libc.
    const util = dlopen("libutil.so.1", { openpty: openptyDef })
    const libc = dlopen("libc.so.6", { ioctl: ioctlDef })
    openptyFn = util.symbols.openpty as NativeBindings["openpty"]
    ioctlFn = libc.symbols.ioctl as NativeBindings["ioctl"]
  }
  return {
    openpty: openptyFn,
    ioctl: ioctlFn,
    tiocswinsz: platform === "darwin" ? TIOCSWINSZ_DARWIN : TIOCSWINSZ_LINUX,
  }
}

/** winsize struct = { ws_row, ws_col, ws_xpixel, ws_ypixel } as u16[4]. */
const winsize = (cols: number, rows: number): Uint16Array =>
  new Uint16Array([rows, cols, 0, 0])

export const createBunFfiPtySpawner = (): PtySpawner => {
  return {
    spawn(input) {
      try {
        const native = loadNative()
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("node:fs") as typeof import("node:fs")

        const master = new Int32Array(1)
        const slave = new Int32Array(1)
        const ws = winsize(input.cols, input.rows)
        const rc = native.openpty(
          master as unknown as NodeJS.TypedArray,
          slave as unknown as NodeJS.TypedArray,
          null,
          null,
          ws as unknown as NodeJS.TypedArray,
        )
        if (rc !== 0) {
          return {
            ok: false,
            error: {
              kind: "spawn-failed",
              message: `openpty failed (rc=${rc})`,
            },
          }
        }
        const masterFd = master[0] as number
        const slaveFd = slave[0] as number

        // Run the shell attached to the slave end of the pty. Bun.spawn accepts a
        // raw fd for each stdio slot; the child sees a real tty.
        const child = Bun.spawn([input.command, ...input.args], {
          cwd: input.cwd,
          env: input.env,
          stdio: [slaveFd, slaveFd, slaveFd] as unknown as [
            "inherit",
            "inherit",
            "inherit",
          ],
        })
        // Close the PARENT's copy of the slave fd now that the child has dup'd it.
        // If we keep it open, the pty never sees EOF when the child exits and the
        // master read stream keeps Bun's event loop alive forever (leaked handle).
        try {
          fs.closeSync(slaveFd)
        } catch {
          /* already closed */
        }

        // Late-bound listener arrays: launch() registers onData/onExit AFTER
        // spawn returns, but stream 'data' events fire on later ticks, so no
        // initial output (the prompt) is lost.
        const dataCbs: Array<(bytes: Uint8Array) => void> = []
        const exitCbs: Array<(exitCode: number) => void> = []
        let closed = false

        const closeMaster = (): void => {
          if (closed) return
          closed = true
          try {
            stream.destroy()
          } catch {
            /* already gone */
          }
          try {
            fs.closeSync(masterFd)
          } catch {
            /* already closed */
          }
        }

        const stream = fs.createReadStream("", {
          fd: masterFd,
          autoClose: false,
        })
        stream.on("data", (chunk: string | Buffer) => {
          const buf =
            typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
          const bytes = new Uint8Array(buf)
          for (const cb of dataCbs) cb(bytes)
        })
        // The master read stream errors with EIO when the slave side closes on
        // some platforms; that's the normal end-of-pty signal, not a fault.
        stream.on("error", () => {
          /* surfaced via onExit below */
        })

        void child.exited.then((code: number) => {
          for (const cb of exitCbs) cb(code)
          closeMaster()
        })

        const handle: PtyHandle = {
          onData(cb) {
            dataCbs.push(cb)
          },
          onExit(cb) {
            exitCbs.push(cb)
          },
          write(bytes) {
            if (closed) return
            try {
              fs.writeSync(masterFd, bytes)
            } catch {
              /* pty gone */
            }
          },
          resize(cols, rows) {
            if (closed) return
            const arg = winsize(cols, rows)
            native.ioctl(
              masterFd,
              native.tiocswinsz,
              arg as unknown as NodeJS.TypedArray,
            )
          },
          kill() {
            try {
              child.kill()
            } catch {
              /* already exited */
            }
            closeMaster()
          },
        }
        const ok: Result<PtyHandle, TerminalError> = { ok: true, value: handle }
        return ok
      } catch (err) {
        return {
          ok: false,
          error: {
            kind: "spawn-failed",
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }
    },
  }
}
