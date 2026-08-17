import { beforeEach, describe, expect, it, mock } from "bun:test"
import { createNoopLogger } from "@spectrum/logger"
import type { createAppContext } from "./composition"
import { __resetGuiPathAsyncForTest } from "./gui/resolve-path"
import type { RunGuiDeps } from "./main"
import { buildRealDeps, main } from "./main"

/** Build a fake context with minimal stand-ins so real IO is never triggered. */
const fakeFactory = (() =>
  ({
    config: {
      load: async () => ({
        ok: true,
        value: {
          version: 2,
          providers: [],
          models: [],
          settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
        },
      }),
    },
    secrets: {},
    sessions: {
      create: () => ({ ok: true, value: {} }),
      query: () => ({ ok: true, value: [] }),
      init: () => ({ ok: true, value: undefined }),
      reconcileOrphaned: () => ({ ok: true, value: 0 }),
    },
    registry: { list: async () => ({ ok: true, value: [] }) },
    launch: () => ({ ok: true, value: { pid: 1, exited: Promise.resolve(0) } }),
    proxy: {
      isRunning: async () => false,
      start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
    },
    factory: {},
    gateway: {},
    runtime: {
      readProxyKey: async () => null,
      writeProxyKey: async () => ({ ok: true, value: undefined }),
      clear: async () => {},
    },
    testProvider: async () => ({ ok: true, value: { ok: true, latencyMs: 0 } }),
    proxyPort: 4000,
    proxyBaseUrl: "http://127.0.0.1:4000",
    genProxyKey: () => "k",
    paths: { configFile: "", dbFile: "", harnessDir: "" },
    log: createNoopLogger(),
  }) as never) as typeof createAppContext

describe("module side effects", () => {
  it("does not start the proxy or open a window merely by importing main.ts", async () => {
    const mod = await import("./main")
    expect(typeof mod.main).toBe("function")
    expect(typeof mod.buildRealDeps).toBe("function")
  })
})

describe("buildRealDeps", () => {
  it("produces a RunGuiDeps whose startProxy and openWindow are callable (no runCli)", () => {
    const deps = buildRealDeps(fakeFactory as never)
    expect(typeof deps.startProxy).toBe("function")
    expect(typeof deps.openWindow).toBe("function")
    // GUI-only: no runCli field on the deps
    expect((deps as unknown as Record<string, unknown>).runCli).toBeUndefined()
  })

  // The real entry must supply the quit gate: it is the ONLY caller of AppContext.shutdown(),
  // so an omitted default orphans every supervised plugin process on quit.
  it("produces a RunGuiDeps that carries a quit gate installer", () => {
    const deps = buildRealDeps(fakeFactory as never)
    expect(typeof deps.installQuitGate).toBe("function")
  })

  it("calls reconcileOrphaned() on the session store when startProxy is invoked (GUI startup)", async () => {
    const reconcileOrphaned = mock(() => ({ ok: true as const, value: 0 }))
    const factoryWithSpy = (() =>
      ({
        config: {
          load: async () => ({
            ok: true,
            value: {
              version: 2,
              providers: [],
              models: [],
              settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
            },
          }),
        },
        secrets: {},
        sessions: {
          create: () => ({ ok: true, value: {} }),
          query: () => ({ ok: true, value: [] }),
          init: () => ({ ok: true, value: undefined }),
          reconcileOrphaned,
        },
        registry: { list: async () => ({ ok: true, value: [] }) },
        launch: () => ({
          ok: true,
          value: { pid: 1, exited: Promise.resolve(0) },
        }),
        proxy: {
          isRunning: async () => false,
          start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
        },
        factory: {},
        gateway: {},
        runtime: {
          readProxyKey: async () => null,
          writeProxyKey: async () => ({ ok: true, value: undefined }),
          clear: async () => {},
        },
        testProvider: async () => ({
          ok: true,
          value: { ok: true, latencyMs: 0 },
        }),
        proxyPort: 4000,
        proxyBaseUrl: "http://127.0.0.1:4000",
        genProxyKey: () => "k",
        paths: { configFile: "", dbFile: "", harnessDir: "" },
        log: createNoopLogger(),
      }) as never) as typeof createAppContext

    const deps = buildRealDeps(factoryWithSpy as never)
    // startProxy is the GUI-only path; trigger it and wait for the async load to complete
    deps.startProxy()
    // The async config.load() is deferred; flush the microtask queue
    await Promise.resolve()
    expect(reconcileOrphaned).toHaveBeenCalledTimes(1)
  })

  it("logs a redacted warn on the 'startup' scope when reconcileOrphaned fails during startProxy", async () => {
    const warns: Array<{
      scope: string
      msg: string
      fields?: Record<string, unknown>
    }> = []
    const makeCapturingLog = () => {
      const child = (scope: string) => ({
        debug: () => {},
        info: () => {},
        error: () => {},
        fatal: () => {},
        warn: (msg: string, fields?: Record<string, unknown>) =>
          warns.push(
            fields === undefined ? { scope, msg } : { scope, msg, fields },
          ),
        child: () => child(scope),
      })
      return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child,
      }
    }
    const factoryWithFailingReconcile = (() =>
      ({
        config: {
          load: async () => ({
            ok: true,
            value: {
              version: 2,
              providers: [],
              models: [],
              settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
            },
          }),
        },
        secrets: {},
        sessions: {
          create: () => ({ ok: true, value: {} }),
          query: () => ({ ok: true, value: [] }),
          init: () => ({ ok: true, value: undefined }),
          reconcileOrphaned: () => ({
            ok: false as const,
            error: { kind: "db-failed" as const, detail: "boom" },
          }),
        },
        registry: { list: async () => ({ ok: true, value: [] }) },
        launch: () => ({
          ok: true,
          value: { pid: 1, exited: Promise.resolve(0) },
        }),
        proxy: {
          isRunning: async () => false,
          start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
        },
        factory: {},
        gateway: {},
        runtime: {
          readProxyKey: async () => null,
          writeProxyKey: async () => ({ ok: true, value: undefined }),
          clear: async () => {},
        },
        testProvider: async () => ({
          ok: true,
          value: { ok: true, latencyMs: 0 },
        }),
        proxyPort: 4000,
        proxyBaseUrl: "http://127.0.0.1:4000",
        genProxyKey: () => "k",
        paths: { configFile: "", dbFile: "", harnessDir: "" },
        log: makeCapturingLog(),
      }) as never) as typeof createAppContext

    const deps = buildRealDeps(factoryWithFailingReconcile as never)
    deps.startProxy()
    await Promise.resolve()
    expect(warns).toHaveLength(1)
    expect(warns[0]?.scope).toBe("startup")
    expect(warns[0]?.msg).toContain("reconcile")
    expect(warns[0]?.fields).toEqual({ kind: "db-failed", detail: "boom" })
  })

  it("startProxy returns a ProxyHandle whose stop() can be invoked", () => {
    const deps = buildRealDeps(fakeFactory as never)
    const handle = deps.startProxy()
    expect(typeof handle.stop).toBe("function")
    // Should not throw
    handle.stop()
  })
})

describe("buildRealDeps startProxy PATH enrichment", () => {
  beforeEach(() => __resetGuiPathAsyncForTest())

  it("does NOT run a synchronous spawn during startProxy (enrichment is async, fire-and-forget)", () => {
    // startProxy must return synchronously without having awaited any shell probe.
    let syncSpawnObserved = false
    // Patch Bun.spawnSync to detect any synchronous spawn on the startProxy path.
    const origSpawnSync = Bun.spawnSync
    Bun.spawnSync = (() => {
      syncSpawnObserved = true
      return {
        success: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      } as never
    }) as never
    try {
      const deps = buildRealDeps(fakeFactory as never)
      deps.startProxy()
      expect(syncSpawnObserved).toBe(false)
    } finally {
      Bun.spawnSync = origSpawnSync
    }
  })

  it("exposes ensureGuiPathResolved which resolves after the async enrichment settles", async () => {
    const deps = buildRealDeps(fakeFactory as never)
    expect(typeof deps.ensureGuiPathResolved).toBe("function")
    // No throw; resolves (the real async probe runs, but the memo means it runs once).
    await expect(deps.ensureGuiPathResolved()).resolves.toBeUndefined()
  })
})

describe("main (entry wiring)", () => {
  /** A RunGuiDeps that records whether/how each path ran, no real effects. */
  const recordingDeps = (record: { guiOpened?: boolean }): RunGuiDeps => ({
    startProxy: () => {
      record.guiOpened = false // startProxy itself doesn't open
      return { stop: () => {}, ready: Promise.resolve() }
    },
    openWindow: () => {
      record.guiOpened = true
    },
    ensureGuiPathResolved: async () => {},
  })

  it("calls startProxy then openWindow regardless of argv (no mode detection)", async () => {
    const order: string[] = []
    const deps: RunGuiDeps = {
      startProxy: () => {
        order.push("startProxy")
        return { stop: () => {}, ready: Promise.resolve() }
      },
      openWindow: () => {
        order.push("openWindow")
      },
      ensureGuiPathResolved: async () => {},
    }
    // Even with CLI-shaped argv, the GUI always runs.
    await main(["bun", "/path/main.ts", "list", "harnesses"], deps)
    expect(order).toEqual(["startProxy", "openWindow"])
  })

  it("runs the GUI path even with an empty argv", async () => {
    const record: { guiOpened?: boolean } = {}
    await main([], recordingDeps(record))
    expect(record.guiOpened).toBe(true)
  })

  // Without this the app has NO exit path: nothing else calls AppContext.shutdown(), so every
  // supervised plugin process survives the quit as an orphan.
  it("installs the quit gate before the window opens when the GUI starts", async () => {
    const order: string[] = []
    await main([], {
      startProxy: () => ({ stop: () => {}, ready: Promise.resolve() }),
      openWindow: () => order.push("openWindow"),
      ensureGuiPathResolved: async () => {},
      installQuitGate: () => order.push("installQuitGate"),
    })
    expect(order).toEqual(["installQuitGate", "openWindow"])
  })
})

describe("main startup sequencing (regression: post-update startup SIGTRAP)", () => {
  // The packaged-GUI Worker crashes (EXC_BREAKPOINT / PAC-IB trap) when Electrobun's
  // native->Worker JSCallback traffic from the webview's first load lands while the
  // Worker is still executing the startup burst (config load -> proxy start). The
  // window (and therefore the webview) must not open until `startProxy().ready`
  // settles, bounded by a cap so a hung config load can never hold the UI hostage.

  /** A fully manual `StartupWait` seam — no real timers (so no test ever waits on wall-clock,
   *  and none sits at bun's 5s per-test timeout), and it records scheduled + cleared handles
   *  so a test can prove the cap timer is cleared when `ready` wins (no leaked timer). */
  const makeManualWait = (capMs = 3000) => {
    const scheduled: Array<{ handle: number; fn: () => void }> = []
    const cleared: number[] = []
    let next = 1
    const wait = {
      capMs,
      setTimeout: (fn: () => void, _ms: number): number => {
        const handle = next++
        scheduled.push({ handle, fn })
        return handle
      },
      clearTimeout: (h: unknown): void => {
        cleared.push(h as number)
      },
    }
    return { scheduled, cleared, wait }
  }

  /** Capturing logger that records `error`/`warn` with scope+msg (mirrors the reconcile test's
   *  helper but keeps the higher levels so the boundary logs can be asserted). */
  const makeCapturingLog = (
    sink: Array<{ level: "warn" | "error"; scope: string; msg: string }>,
  ) => {
    const child = (scope: string) => ({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => sink.push({ level: "warn", scope, msg }),
      error: (msg: string) => sink.push({ level: "error", scope, msg }),
      fatal: () => {},
      child: () => child(scope),
    })
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child,
    }
  }

  it("does not open the window until proxy start settles, then clears the cap timer", async () => {
    let resolveReady: () => void = () => {}
    const order: string[] = []
    const m = makeManualWait()
    const deps: RunGuiDeps = {
      startProxy: () => ({
        stop: () => {},
        ready: new Promise<void>((r) => {
          resolveReady = r
        }),
      }),
      openWindow: () => {
        order.push("openWindow")
      },
      ensureGuiPathResolved: async () => {},
    }
    const done = main([], deps, m.wait)
    // Flush microtasks: the window must still be closed while ready is pending.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    expect(m.scheduled).toHaveLength(1) // cap armed
    const armed = m.scheduled[0]
    if (!armed) throw new Error("cap timer was not armed")
    resolveReady()
    await done
    expect(order).toEqual(["openWindow"])
    // ready won the race: the cap timer must be cleared (else it leaks / fires spuriously),
    // and its callback must never have run.
    expect(m.cleared).toEqual([armed.handle])
  })

  it("opens the window after the cap when startup never settles, and signals cap expiry", async () => {
    const m = makeManualWait()
    let opened = false
    let capExpired = false
    const deps: RunGuiDeps = {
      startProxy: () => ({
        stop: () => {},
        ready: new Promise<void>(() => {}), // never settles
      }),
      openWindow: () => {
        opened = true
      },
      ensureGuiPathResolved: async () => {},
      onStartupCapExpired: () => {
        capExpired = true
      },
    }
    const done = main([], deps, m.wait)
    await Promise.resolve()
    expect(opened).toBe(false)
    m.scheduled[0]?.fn() // the cap fires
    await done
    expect(opened).toBe(true)
    expect(capExpired).toBe(true)
  })

  it("never rejects (main resolves) even if the injected cap seam fires synchronously", async () => {
    // The never-reject contract must hold for ANY injected StartupWait — including a fake that
    // invokes its callback synchronously inside setTimeout (would hit a TDZ ReferenceError if
    // `cap` were a `const` initialized by the setTimeout call). main must still resolve.
    let opened = false
    const syncCapWait = {
      capMs: 0,
      setTimeout: (fn: () => void, _ms: number): number => {
        fn() // fire immediately, before setTimeout returns
        return 1
      },
      clearTimeout: (): void => {},
    }
    const deps: RunGuiDeps = {
      startProxy: () => ({
        stop: () => {},
        ready: new Promise<void>(() => {}),
      }),
      openWindow: () => {
        opened = true
      },
      ensureGuiPathResolved: async () => {},
    }
    await expect(main([], deps, syncCapWait)).resolves.toBeUndefined()
    expect(opened).toBe(true)
  })

  it("buildRealDeps startProxy exposes ready that settles after config load + proxy start", async () => {
    const proxyStart = mock(() => ({
      hostname: "127.0.0.1",
      port: 4000,
      stop: () => {},
    }))
    const factoryWithProxySpy = (() =>
      ({
        config: {
          load: async () => ({
            ok: true,
            value: {
              version: 2,
              providers: [],
              models: [],
              settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
            },
          }),
        },
        secrets: {},
        sessions: {
          create: () => ({ ok: true, value: {} }),
          query: () => ({ ok: true, value: [] }),
          init: () => ({ ok: true, value: undefined }),
          reconcileOrphaned: () => ({ ok: true, value: 0 }),
        },
        registry: { list: async () => ({ ok: true, value: [] }) },
        launch: () => ({
          ok: true,
          value: { pid: 1, exited: Promise.resolve(0) },
        }),
        proxy: { isRunning: async () => false, start: proxyStart },
        factory: {},
        gateway: {},
        runtime: {
          readProxyKey: async () => null,
          writeProxyKey: async () => ({ ok: true, value: undefined }),
          clear: async () => {},
        },
        testProvider: async () => ({
          ok: true,
          value: { ok: true, latencyMs: 0 },
        }),
        proxyPort: 4000,
        proxyBaseUrl: "http://127.0.0.1:4000",
        genProxyKey: () => "k",
        paths: { configFile: "", dbFile: "", harnessDir: "" },
        log: createNoopLogger(),
      }) as never) as typeof createAppContext

    const deps = buildRealDeps(factoryWithProxySpy as never)
    const handle = deps.startProxy()
    await handle.ready
    expect(proxyStart).toHaveBeenCalledTimes(1)
  })

  it("buildRealDeps startProxy ready settles (never rejects) when config load fails", async () => {
    const factoryWithFailingConfig = (() =>
      ({
        config: {
          load: async () => ({
            ok: false as const,
            error: { kind: "migration-failed" as const, detail: "boom" },
          }),
        },
        secrets: {},
        sessions: {
          create: () => ({ ok: true, value: {} }),
          query: () => ({ ok: true, value: [] }),
          init: () => ({ ok: true, value: undefined }),
          reconcileOrphaned: () => ({ ok: true, value: 0 }),
        },
        registry: { list: async () => ({ ok: true, value: [] }) },
        launch: () => ({
          ok: true,
          value: { pid: 1, exited: Promise.resolve(0) },
        }),
        proxy: {
          isRunning: async () => false,
          start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
        },
        factory: {},
        gateway: {},
        runtime: {
          readProxyKey: async () => null,
          writeProxyKey: async () => ({ ok: true, value: undefined }),
          clear: async () => {},
        },
        testProvider: async () => ({
          ok: true,
          value: { ok: true, latencyMs: 0 },
        }),
        proxyPort: 4000,
        proxyBaseUrl: "http://127.0.0.1:4000",
        genProxyKey: () => "k",
        paths: { configFile: "", dbFile: "", harnessDir: "" },
        log: createNoopLogger(),
      }) as never) as typeof createAppContext

    const deps = buildRealDeps(factoryWithFailingConfig as never)
    const handle = deps.startProxy()
    await expect(handle.ready).resolves.toBeUndefined()
  })

  it("buildRealDeps startProxy ready settles AND logs a boundary error when the load chain THROWS", async () => {
    // The load/start chain can reject, not just return a Result-failure: e.g. proxy.start ->
    // Bun.serve throwing EADDRINUSE against a stale instance. `ready` must still settle (never
    // reject — it gates a top-level await in the Worker entry), and the throw must be logged at
    // the boundary rather than silently swallowed (the observability regression the first cut had).
    const logs: Array<{ level: "warn" | "error"; scope: string; msg: string }> =
      []
    const factoryThatThrows = (() =>
      ({
        config: {
          load: async () => {
            throw new Error("kaboom")
          },
        },
        secrets: {},
        sessions: {
          create: () => ({ ok: true, value: {} }),
          query: () => ({ ok: true, value: [] }),
          init: () => ({ ok: true, value: undefined }),
          reconcileOrphaned: () => ({ ok: true, value: 0 }),
        },
        registry: { list: async () => ({ ok: true, value: [] }) },
        launch: () => ({
          ok: true,
          value: { pid: 1, exited: Promise.resolve(0) },
        }),
        proxy: {
          isRunning: async () => false,
          start: () => ({ hostname: "127.0.0.1", port: 4000, stop: () => {} }),
        },
        factory: {},
        gateway: {},
        runtime: {
          readProxyKey: async () => null,
          writeProxyKey: async () => ({ ok: true, value: undefined }),
          clear: async () => {},
        },
        testProvider: async () => ({
          ok: true,
          value: { ok: true, latencyMs: 0 },
        }),
        proxyPort: 4000,
        proxyBaseUrl: "http://127.0.0.1:4000",
        genProxyKey: () => "k",
        paths: { configFile: "", dbFile: "", harnessDir: "" },
        log: makeCapturingLog(logs),
      }) as never) as typeof createAppContext

    const deps = buildRealDeps(factoryThatThrows as never)
    const handle = deps.startProxy()
    await expect(handle.ready).resolves.toBeUndefined()
    expect(
      logs.some(
        (l) =>
          l.level === "error" &&
          l.scope === "startup" &&
          l.msg.includes("threw"),
      ),
    ).toBe(true)
  })
})

// MUST be the last test in the file: it calls main() which internally invokes
// deps.startProxy() and deps.openWindow(). We use a recording openWindow stub
// (not the real one from buildRealDeps) to avoid kicking off the real
// Electrobun tray/menu/updater work, which races with test teardown and would
// surface as unhandled-rejection noise. The regression guard's job is to
// verify main() does not call Bun.spawnSync; the real openWindow's callability
// is covered separately in the buildRealDeps block.
describe("main startup regression guard", () => {
  it("main() startup path performs no synchronous subprocess spawn (regression: Worker brk-1 crash)", async () => {
    // Covers the FULL main() flow — startProxy AND the now-post-await openWindow — with
    // Bun.spawnSync patched for the whole duration, so a sync spawn added anywhere in main()
    // (including after the readiness await) is caught. Since openWindow moved behind the await,
    // the old `void main(...)` + immediate assertion would have restored spawnSync before the
    // continuation ran and missed a post-await spawn; awaiting fixes that. A manual cap seam
    // that never fires (ready wins via fakeFactory's resolved config load) keeps this off real
    // timers while exercising the normal, non-capped path.
    let syncSpawnObserved = false
    const origSpawnSync = Bun.spawnSync
    Bun.spawnSync = (() => {
      syncSpawnObserved = true
      return {
        success: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      } as never
    }) as never
    try {
      const realDeps = buildRealDeps(fakeFactory as never)
      const deps = {
        startProxy: realDeps.startProxy,
        openWindow: () => {},
        ensureGuiPathResolved: realDeps.ensureGuiPathResolved,
      }
      const wait = {
        capMs: 3000,
        setTimeout: (_fn: () => void, _ms: number): number => 1, // never fires; ready wins
        clearTimeout: (): void => {},
      }
      await main([], deps, wait)
      expect(syncSpawnObserved).toBe(false)
    } finally {
      Bun.spawnSync = origSpawnSync
    }
  })
})
