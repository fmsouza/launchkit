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

export interface NativeBindings {
  openpty(
    amaster: NodeJS.TypedArray,
    aslave: NodeJS.TypedArray,
    name: null,
    termios: null,
    winsize: NodeJS.TypedArray,
  ): number
  ioctl(fd: number, request: bigint, argp: NodeJS.TypedArray): number
  tiocswinsz: bigint
  /**
   * Retained `dlopen` Library handles. `bun:ffi` compiles a per-symbol native
   * trampoline that is owned by the Library handle; if that handle is garbage
   * collected the trampoline memory is freed, and the next call to a symbol
   * branches into freed code — on arm64e (Apple Silicon) that surfaces as a
   * pointer-authentication trap (PAC IB) and a hard process crash. Keeping the
   * handles reachable for as long as the symbols are callable prevents that.
   * Never invoked directly; the array exists purely to anchor the references.
   */
  readonly handles: readonly unknown[]
}

/** The slice of `bun:ffi` that {@link loadNative} consumes (injectable for tests). */
type FfiModule = Pick<typeof import("bun:ffi"), "dlopen" | "FFIType">

/**
 * dlopen libc/libutil for `openpty` + `ioctl`. Throws if the platform is
 * unsupported. The returned bindings retain the `dlopen` handle(s) (see
 * {@link NativeBindings.handles}) so the native trampolines stay alive.
 */
export const loadNative = (
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ffi: FfiModule = require("bun:ffi") as FfiModule,
): NativeBindings => {
  const { dlopen, FFIType } = ffi
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
  const handles: unknown[] = []
  if (platform === "darwin") {
    // libutil.dylib re-exports libSystem, so one handle has both symbols.
    const lib = dlopen("libutil.dylib", {
      openpty: openptyDef,
      ioctl: ioctlDef,
    })
    handles.push(lib)
    openptyFn = lib.symbols.openpty as NativeBindings["openpty"]
    ioctlFn = lib.symbols.ioctl as NativeBindings["ioctl"]
  } else {
    // Linux: openpty in libutil, ioctl in libc.
    const util = dlopen("libutil.so.1", { openpty: openptyDef })
    const libc = dlopen("libc.so.6", { ioctl: ioctlDef })
    handles.push(util, libc)
    openptyFn = util.symbols.openpty as NativeBindings["openpty"]
    ioctlFn = libc.symbols.ioctl as NativeBindings["ioctl"]
  }
  return {
    openpty: openptyFn,
    ioctl: ioctlFn,
    tiocswinsz: platform === "darwin" ? TIOCSWINSZ_DARWIN : TIOCSWINSZ_LINUX,
    handles,
  }
}

/** winsize struct = { ws_row, ws_col, ws_xpixel, ws_ypixel } as u16[4]. */
const winsize = (cols: number, rows: number): Uint16Array =>
  new Uint16Array([rows, cols, 0, 0])

export const createBunFfiPtySpawner = (
  loadNativeFn: () => NativeBindings = loadNative,
): PtySpawner => {
  // Load the native bindings ONCE and reuse them for every spawn. This both
  // avoids re-`dlopen`-ing per launch and — crucially — keeps the single
  // Library handle (and its native trampolines) reachable for the lifetime of
  // the spawner, which composition holds for the whole process. Re-dlopening
  // per spawn would discard each prior handle, risking a freed trampoline and
  // an arm64e pointer-authentication crash (see NativeBindings.handles).
  let cached: NativeBindings | undefined
  const getNative = (): NativeBindings => {
    if (!cached) cached = loadNativeFn()
    return cached
  }
  return {
    spawn(input) {
      try {
        const native = getNative()
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

        // Late-bound listener arrays: launch() registers onData/onExit AFTER
        // spawn returns, but stream 'data' events fire on later ticks, so no
        // initial output (the prompt) is lost.
        const dataCbs: Array<(bytes: Uint8Array) => void> = []
        const exitCbs: Array<(exitCode: number) => void> = []
        // Track each fd's close separately: an fd number can be reused after
        // close, so double-closing risks clobbering an unrelated fd.
        let slaveClosed = false
        let masterClosed = false
        let closed = false

        // Close the PARENT's slave fd. CRUCIAL TIMING: this must happen only
        // AFTER the child has exited — NOT right after spawn. The pty buffers the
        // child's output on the master side; on Linux, closing the last slave fd
        // makes the next master read return EIO and DROPS any not-yet-read bytes.
        // A fast-exiting child (e.g. `sh -c "echo hi"`) writes + exits before the
        // read stream's first tick, so closing the slave early loses its output
        // (works on macOS, fails on Linux). Keeping the slave open until exit lets
        // the master deliver everything, then closing it triggers EOF/EIO so the
        // read stream ends and the event loop drains (no leaked handle).
        const closeSlave = (): void => {
          if (slaveClosed) return
          slaveClosed = true
          try {
            fs.closeSync(slaveFd)
          } catch {
            /* already closed */
          }
        }
        const closeMaster = (): void => {
          if (closed) return
          closed = true
          try {
            stream.destroy()
          } catch {
            /* already gone */
          }
          if (!masterClosed) {
            masterClosed = true
            try {
              fs.closeSync(masterFd)
            } catch {
              /* already closed */
            }
          }
          closeSlave()
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
        // `end` (macOS EOF) and `error` (Linux EIO) both signal end-of-pty once
        // the slave is closed — tear down the master either way.
        stream.on("end", closeMaster)
        stream.on("error", closeMaster)

        void child.exited.then((code: number) => {
          for (const cb of exitCbs) cb(code)
          // Now that the child is gone, close the slave so the master drains its
          // buffer and then EOFs — which fires `end`/`error` → closeMaster.
          closeSlave()
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
