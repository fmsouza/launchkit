import { describe, expect, it } from "bun:test"
import type { LaunchParams } from "@spectrum/harnesses"
import { createInMemoryRuntimeState, decodeSessionToken } from "@spectrum/proxy"
import {
  type HarnessDefinition,
  type HarnessId,
  HarnessIdSchema,
} from "@spectrum/types"
import type { StartProxyDeps } from "./deps"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"
import { createMemoryWriter } from "./writer"

const claude: HarnessDefinition = {
  id: HarnessIdSchema.parse("claude"),
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  builtIn: true,
}

describe("launch", () => {
  it("returns a usage error when no harness id is given", async () => {
    const result = await runCli(makeFakeDeps({ harnesses: [claude] }))([
      "launch",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("returns a usage error when the harness id is not in the registry", async () => {
    const result = await runCli(makeFakeDeps({ harnesses: [claude] }))([
      "launch",
      "ghost",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("reuses the running proxy when one is already up (proxied launch)", async () => {
    let started = false
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: true,
        proxyStartSpy: () => {
          started = true
        },
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])
    expect(result).toEqual({ ok: true, value: undefined })
    expect(started).toBe(false) // proxy.start MUST NOT be called when one is already running
  })

  it("reuses the running proxy's key instead of minting a new one when the proxy is already up", async () => {
    const launchCalls: LaunchParams[] = []
    const runtime = createInMemoryRuntimeState()
    await runtime.writeProxyKey("KEY-FROM-RUNNING")
    const deps = makeFakeDeps({
      harnesses: [claude],
      isProxyRunning: true,
      runtime,
      proxyKey: "FRESH",
      proxyStartSpy: () => {
        throw new Error("proxy.start MUST NOT be called when one is running")
      },
      launchSpy: (p) => launchCalls.push(p),
    })

    const result = await runCli(deps)([
      "launch",
      "claude",
      "--model",
      "fast",
      "--cwd",
      "/tmp/proj",
    ])

    expect(result).toEqual({ ok: true, value: undefined })
    const route = launchCalls[0]?.route
    expect(route?.kind).toBe("proxied")
    if (route?.kind === "proxied") {
      // The route carries the ENCODED session token, not the bare master key.
      const decoded = decodeSessionToken(route.proxyKey)
      expect(decoded.masterKey).toBe("KEY-FROM-RUNNING")
      expect(decoded.modelId).toBe("fast")
    }
  })

  it("mints and persists a key when starting a fresh proxy", async () => {
    let started = false
    let startProxyKey: string | undefined
    const runtime = createInMemoryRuntimeState()
    const launchCalls: LaunchParams[] = []
    const deps = makeFakeDeps({
      harnesses: [claude],
      isProxyRunning: false,
      runtime,
      proxyKey: "MINTED-KEY",
      proxyStartSpy: (opts) => {
        started = true
        startProxyKey = opts.proxyKey
      },
      launchSpy: (p) => launchCalls.push(p),
    })

    const result = await runCli(deps)([
      "launch",
      "claude",
      "--model",
      "fast",
      "--cwd",
      "/tmp/proj",
    ])

    expect(result).toEqual({ ok: true, value: undefined })
    expect(started).toBe(true)
    // (a) proxy.start receives the BARE master key, never the encoded token
    expect(startProxyKey).toBe("MINTED-KEY")
    // (b) writeProxyKey persists the BARE master key
    expect(await runtime.readProxyKey()).toBe("MINTED-KEY")
    // (c) the route carries the ENCODED session token
    const route = launchCalls[0]?.route
    expect(route?.kind).toBe("proxied")
    if (route?.kind === "proxied") {
      const decoded = decodeSessionToken(route.proxyKey)
      expect(decoded.masterKey).toBe("MINTED-KEY")
      expect(decoded.modelId).toBe("fast")
      // bare-vs-encoded split: the route key is NOT the bare master key
      expect(route.proxyKey).not.toBe("MINTED-KEY")
    }
  })

  it("starts an ephemeral proxy when none is running (proxied launch)", async () => {
    const startCalls: StartProxyDeps[] = []
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: false,
        proxyStartSpy: (opts) => {
          startCalls.push(opts)
        },
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])
    expect(result).toEqual({ ok: true, value: undefined })
    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.host).toBe("127.0.0.1")
    expect(startCalls[0]?.port).toBe(4000)
  })

  it("awaits the harness exit before returning", async () => {
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })

    let commandReturned = false
    const promise = runCli(
      makeFakeDeps({ harnesses: [claude], launchExited: exited }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"]).then(
      (r) => {
        commandReturned = true
        return r
      },
    )

    // Yield a full macrotask; the command must NOT have returned while the harness
    // (its `exited` promise) is still pending.
    await new Promise((r) => setTimeout(r, 0))
    expect(commandReturned).toBe(false)

    resolveExit(0)
    const result = await promise
    expect(result).toEqual({ ok: true, value: undefined })
    expect(commandReturned).toBe(true)
  })

  it("stops the proxy it started after the harness exits", async () => {
    const stopOrder: string[] = []
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      resolveExit = (code: number) => {
        stopOrder.push("exited")
        resolve(code)
      }
    })

    const promise = runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: false,
        launchExited: exited,
        proxyStopSpy: () => stopOrder.push("stop"),
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])

    await Promise.resolve()
    expect(stopOrder).toEqual([]) // not stopped while the harness is alive

    resolveExit(0)
    const result = await promise
    expect(result).toEqual({ ok: true, value: undefined })
    // The owned proxy is stopped only AFTER the harness exits.
    expect(stopOrder).toEqual(["exited", "stop"])
  })

  it("does NOT stop the proxy when reusing an already-running one", async () => {
    let stopped = false
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: true,
        launchExited: Promise.resolve(0),
        proxyStopSpy: () => {
          stopped = true
        },
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])

    expect(result).toEqual({ ok: true, value: undefined })
    expect(stopped).toBe(false) // a reused proxy is NOT owned by this run, so never stopped
  })

  it("launches the harness via a proxied route with the resolved model id and records a session", async () => {
    const launchCalls: LaunchParams[] = []
    const out = createMemoryWriter()
    const deps = makeFakeDeps({
      out,
      harnesses: [claude],
      launchSpy: (params) => {
        launchCalls.push(params)
      },
      launchResult: {
        ok: true,
        value: { pid: 4321, exited: Promise.resolve(0) },
      },
    })

    const result = await runCli(deps)([
      "launch",
      "claude",
      "--model",
      "fast",
      "--cwd",
      "/tmp/proj",
    ])

    expect(result).toEqual({ ok: true, value: undefined })
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.harness.id).toBe("claude" as HarnessId)
    const route = launchCalls[0]?.route
    expect(route?.kind).toBe("proxied")
    if (route?.kind === "proxied") {
      expect(String(route.modelId)).toBe("fast")
      expect(route.proxyUrl).toBe("http://127.0.0.1:4000")
    }

    // The pid and a session id are reported.
    const text = out.lines.join("\n")
    expect(text).toContain("4321")
    expect(text).toContain("s_1")

    // A session row was persisted with the model id.
    const sessionsList = deps.sessions.query()
    expect(sessionsList.ok && sessionsList.value).toHaveLength(1)
    expect(sessionsList.ok && sessionsList.value[0]?.harnessId).toBe(
      "claude" as HarnessId,
    )
    expect(sessionsList.ok && String(sessionsList.value[0]?.modelId)).toBe(
      "fast",
    )
  })

  it("launches a DIRECT (bypass) route and starts NO proxy when no model is resolved", async () => {
    const launchCalls: LaunchParams[] = []
    let proxyStarted = false
    let isRunningChecked = false
    const out = createMemoryWriter()
    const base = makeFakeDeps({
      out,
      harnesses: [claude],
      launchSpy: (p) => launchCalls.push(p),
      proxyStartSpy: () => {
        proxyStarted = true
      },
    })
    const deps = {
      ...base,
      proxy: {
        ...base.proxy,
        isRunning: async (): Promise<boolean> => {
          isRunningChecked = true
          return false
        },
      },
    }

    const result = await runCli(deps)([
      "launch",
      "claude",
      "--cwd",
      "/tmp/proj",
    ])

    expect(result).toEqual({ ok: true, value: undefined })
    // Direct route, no proxy fields.
    expect(launchCalls[0]?.route.kind).toBe("direct")
    // The proxy was never started, nor even probed, on the bypass path.
    expect(proxyStarted).toBe(false)
    expect(isRunningChecked).toBe(false)

    // The session is recorded WITHOUT a model id.
    const sessionsList = deps.sessions.query()
    expect(sessionsList.ok && sessionsList.value[0]?.modelId).toBeUndefined()
  })

  it("passes the generated proxy key to the proxied route but never writes it to the output", async () => {
    const launchCalls: LaunchParams[] = []
    const out = createMemoryWriter()
    const SECRET_KEY = "super-secret-proxy-key-deadbeef-deadbeef-32b"
    await runCli(
      makeFakeDeps({
        out,
        harnesses: [claude],
        isProxyRunning: false,
        proxyKey: SECRET_KEY,
        launchSpy: (p) => launchCalls.push(p),
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])

    // The encoded session token (containing the master key) reaches the launcher ...
    const route = launchCalls[0]?.route
    expect(route?.kind).toBe("proxied")
    if (route?.kind === "proxied") {
      // The route carries the encoded token; decoding it reveals the original master key.
      const decoded = decodeSessionToken(route.proxyKey)
      expect(decoded.masterKey).toBe(SECRET_KEY)
      expect(decoded.modelId).toBe("fast")
    }
    // ... but the secret key (bare or encoded) is NEVER printed.
    expect(out.lines.join("\n")).not.toContain(SECRET_KEY)
  })

  it("returns a failed error when the launcher fails to spawn", async () => {
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        launchResult: {
          ok: false,
          error: { kind: "spawn-failed", detail: "ENOENT" },
        },
      }),
    )(["launch", "claude", "--model", "fast", "--cwd", "/tmp/proj"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })

  it("returns a failed error when the registry cannot be listed", async () => {
    const result = await runCli(
      makeFakeDeps({
        registryError: { kind: "read-failed", detail: "EACCES" },
      }),
    )(["launch", "claude"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })

  it("returns a failure when launching without a cwd", async () => {
    const result = await runCli(makeFakeDeps({ harnesses: [claude] }))([
      "launch",
      "claude",
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })
})
