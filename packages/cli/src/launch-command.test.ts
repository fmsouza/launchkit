import { describe, expect, it } from "bun:test"
import type { LaunchParams } from "@launchkit/harnesses"
import {
  AliasNameSchema,
  type HarnessDefinition,
  HarnessIdSchema,
} from "@launchkit/types"
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
  defaultAlias: AliasNameSchema.parse("default"),
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

  it("reuses the running proxy when one is already up", async () => {
    let started = false
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: true,
        proxyStartSpy: () => {
          started = true
        },
      }),
    )(["launch", "claude"])
    expect(result).toEqual({ ok: true, value: undefined })
    expect(started).toBe(false) // proxy.start MUST NOT be called when one is already running
  })

  it("starts an ephemeral proxy when none is running", async () => {
    const startCalls: StartProxyDeps[] = []
    const result = await runCli(
      makeFakeDeps({
        harnesses: [claude],
        isProxyRunning: false,
        proxyStartSpy: (opts) => {
          startCalls.push(opts)
        },
      }),
    )(["launch", "claude"])
    expect(result).toEqual({ ok: true, value: undefined })
    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.host).toBe("127.0.0.1")
    expect(startCalls[0]?.port).toBe(4000)
  })

  it("launches the harness with the resolved alias and records a session", async () => {
    const launchCalls: LaunchParams[] = []
    const out = createMemoryWriter()
    const deps = makeFakeDeps({
      out,
      harnesses: [claude],
      launchSpy: (params) => {
        launchCalls.push(params)
      },
      launchResult: { ok: true, value: { pid: 4321 } },
    })

    const result = await runCli(deps)(["launch", "claude", "--model", "fast"])

    expect(result).toEqual({ ok: true, value: undefined })
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.harness.id).toBe("claude")
    expect(String(launchCalls[0]?.model)).toBe("fast")
    expect(launchCalls[0]?.proxyUrl).toBe("http://127.0.0.1:4000")

    // The pid and a session id are reported.
    const text = out.lines.join("\n")
    expect(text).toContain("4321")
    expect(text).toContain("s_1")

    // A session row was persisted.
    const sessionsList = deps.sessions.query()
    expect(sessionsList.ok && sessionsList.value).toHaveLength(1)
    expect(sessionsList.ok && sessionsList.value[0]?.harnessId).toBe("claude")
    expect(sessionsList.ok && String(sessionsList.value[0]?.alias)).toBe("fast")
  })

  it("falls back to the harness defaultAlias when no --model flag is given", async () => {
    const launchCalls: LaunchParams[] = []
    await runCli(
      makeFakeDeps({
        harnesses: [claude],
        launchSpy: (p) => launchCalls.push(p),
      }),
    )(["launch", "claude"])
    expect(String(launchCalls[0]?.model)).toBe("default")
  })

  it("passes the generated proxy key to launch but never writes it to the output", async () => {
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
    )(["launch", "claude"])

    // The key reaches the launcher (which puts it in the child env) ...
    expect(launchCalls[0]?.proxyKey).toBe(SECRET_KEY)
    // ... but is NEVER printed.
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
    )(["launch", "claude"])
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
})
