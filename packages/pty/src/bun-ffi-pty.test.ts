import { describe, expect, it } from "bun:test"
import {
  type NativeBindings,
  createBunFfiPtySpawner,
  loadNative,
} from "./bun-ffi-pty"
import type { SpawnInput } from "./pty-adapter"

// A minimal fake of the slice of `bun:ffi` that `loadNative` consumes. `dlopen`
// returns a single sentinel "Library" handle; we track how many times it was
// called and keep the handle identity so we can assert it stays reachable.
const makeFakeFfi = (): {
  ffi: Parameters<typeof loadNative>[0]
  handle: unknown
  dlopenCalls: () => number
} => {
  const noop = (): number => 0
  const handle = { symbols: { openpty: noop, ioctl: noop }, close: noop }
  let calls = 0
  const ffi = {
    dlopen: (): typeof handle => {
      calls += 1
      return handle
    },
    // loadNative only reads FFIType members to build the call descriptors.
    FFIType: { ptr: "ptr", int: "int", u64: "u64" },
  } as unknown as Parameters<typeof loadNative>[0]
  return { ffi, handle, dlopenCalls: () => calls }
}

const spawnInput: SpawnInput = {
  command: "/bin/sh",
  args: ["-c", "true"],
  cwd: "/tmp",
  env: {},
  cols: 80,
  rows: 24,
}

describe("bun-ffi-pty loadNative", () => {
  // REGRESSION: dropping the `dlopen` Library handle lets it be GC'd, which
  // frees the per-symbol native trampoline. A later call then branches into
  // freed code → an arm64e pointer-authentication trap (PAC IB) and a hard
  // process crash. The bindings MUST retain the handle so it cannot be
  // collected while its symbols are still callable.
  it.skipIf(process.platform === "win32")(
    "retains the dlopen Library handle so its native trampolines can't be GC'd",
    () => {
      const { ffi, handle } = makeFakeFfi()

      const native: NativeBindings = loadNative(ffi)

      expect(native.handles).toContain(handle)
    },
  )

  it.skipIf(process.platform === "win32")(
    "wires openpty/ioctl from the loaded library symbols",
    () => {
      const { ffi, handle } = makeFakeFfi()

      const native = loadNative(ffi)

      expect(native.openpty).toBe(handle.symbols.openpty)
      expect(native.ioctl).toBe(handle.symbols.ioctl)
    },
  )
})

describe("createBunFfiPtySpawner native-load caching", () => {
  // REGRESSION: re-`dlopen`-ing on every spawn churns Library handles (each
  // discarded handle is a dangling-trampoline hazard) and is needless work.
  // The spawner must load the native bindings once and reuse them.
  it("loads native bindings only once across multiple spawns", () => {
    let loaderCalls = 0
    const loader = (): NativeBindings => {
      loaderCalls += 1
      return {
        // Non-zero rc makes spawn() return an error early — before any real
        // Bun.spawn / fd IO — so we exercise only the load path.
        openpty: () => 1,
        ioctl: () => 0,
        tiocswinsz: 0n,
        handles: [],
      }
    }
    const spawner = createBunFfiPtySpawner(loader)

    spawner.spawn(spawnInput)
    spawner.spawn(spawnInput)

    expect(loaderCalls).toBe(1)
  })
})
