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
    const deps = buildRealDeps(fakeFactory)
    expect(typeof deps.startProxy).toBe("function")
    expect(typeof deps.openWindow).toBe("function")
    // GUI-only: no runCli field on the deps
    expect((deps as Record<string, unknown>).runCli).toBeUndefined()
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

    const deps = buildRealDeps(factoryWithSpy)
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
          warns.push({ scope, msg, fields }),
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

    const deps = buildRealDeps(factoryWithFailingReconcile)
    deps.startProxy()
    await Promise.resolve()
    expect(warns).toHaveLength(1)
    expect(warns[0]?.scope).toBe("startup")
    expect(warns[0]?.msg).toContain("reconcile")
    expect(warns[0]?.fields).toEqual({ kind: "db-failed", detail: "boom" })
  })

  it("startProxy returns a ProxyHandle whose stop() can be invoked", () => {
    const deps = buildRealDeps(fakeFactory)
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
      const deps = buildRealDeps(fakeFactory)
      deps.startProxy()
      expect(syncSpawnObserved).toBe(false)
    } finally {
      Bun.spawnSync = origSpawnSync
    }
  })

  it("exposes ensureGuiPathResolved which resolves after the async enrichment settles", async () => {
    const deps = buildRealDeps(fakeFactory)
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
      return { stop: () => {} }
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
        return { stop: () => {} }
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
})
