import { describe, expect, it } from "bun:test"
import type {
  ExtensionManifest,
  ExtensionRegistry,
  LoadedExtension,
  PluginError,
  ProviderContribution,
} from "@spectrum/extensions"
import type { Logger } from "@spectrum/logger"
import {
  type ProcError,
  createControllableProcessSpawner,
  createFakeCommandResolver,
} from "@spectrum/proc"
import type { PluginId } from "@spectrum/types"
import { type Result, ok } from "@spectrum/utils"
import { createProviderHost } from "./host"
import type { HealthProbe } from "./readiness"

type LogRecordish = {
  level: "debug" | "info" | "warn" | "error"
  msg: string
  fields?: Record<string, unknown>
}
type FakeLogger = Logger & { readonly records: readonly LogRecordish[] }

const createFakeLogger = (): FakeLogger => {
  const records: LogRecordish[] = []
  const push =
    (level: LogRecordish["level"]) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push({ level, msg, ...(fields ? { fields } : {}) })
    }
  const self: FakeLogger = {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: () => {},
    child: () => self,
  }
  return self
}

const contribution = (options?: {
  readonly noLaunch?: boolean
  readonly secretInArgs?: boolean
}): ProviderContribution => ({
  id: "acme" as PluginId,
  descriptor: {
    label: "Acme",
    configFields: [],
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    supportsCustomHeaders: false,
    streaming: "incremental",
    reasoning: { shape: "none", supportedTiers: [] },
    discovery: { strategy: "none" },
    actions: [],
  },
  transport: {
    kind: "http",
    wire: "openai",
    ...(options?.noLaunch === true
      ? {}
      : {
          launch: {
            command: "acme-server",
            args:
              options?.secretInArgs === true
                ? ["--port", "{{port}}", "--key", "{{apiKey}}"]
                : ["--port", "{{port}}", "--base", "{{baseUrl}}"],
            envTemplate: {
              ACME_KEY: "{{apiKey}}",
              SPECTRUM_TOKEN: "{{hostToken}}",
            },
            healthPath: "/models",
            readyTimeoutMs: 10_000,
          },
        }),
  },
})

const manifest = (c: ProviderContribution): ExtensionManifest => ({
  apiVersion: "1",
  id: "acme-ext" as PluginId,
  name: "Acme",
  version: "1.0.0",
  contributes: { providers: [c] },
})

const fakeRegistry = (contributions: readonly ProviderContribution[]) => {
  const extensions: readonly LoadedExtension[] = contributions.map((c) => ({
    manifest: manifest(c),
    ignoredContributions: [],
    dir: "/ext/acme",
  }))
  const registry: ExtensionRegistry = {
    list: async (): Promise<Result<readonly LoadedExtension[], PluginError>> =>
      ok(extensions),
    providerDescriptors: async () => ok([]),
  }
  return registry
}

/** Wraps a registry so a test can suspend `list()` and interleave a stop mid-start. */
const gatedRegistry = (
  inner: ExtensionRegistry,
  waitFor: Promise<void> | undefined,
): ExtensionRegistry => ({
  list: async (): Promise<Result<readonly LoadedExtension[], PluginError>> => {
    if (waitFor !== undefined) await waitFor
    return inner.list()
  },
  providerDescriptors: inner.providerDescriptors,
})

/** A promise plus the function that resolves it — the test's interleaving lever. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const run = (providerId = "acme", instanceKey = "k1", apiKey = "sk-x") => ({
  instanceKey,
  providerId,
  secrets: { apiKey },
})

/** Yields enough microtask turns for injected-sleep restart chains to settle. */
const flush = async (turns = 50): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

type HostOptions = {
  readonly contributions?: readonly ProviderContribution[]
  readonly probeToken?: string
  readonly probeOk?: boolean
  readonly probeGate?: Promise<void>
  readonly registryGate?: Promise<void>
  readonly sleepGate?: Promise<void>
  readonly clockStepMs?: number
  readonly maxRestarts?: number
  readonly logger?: Logger
  readonly spawnFailure?: ProcError
}

const host = (options: HostOptions = {}) => {
  const spawner = createControllableProcessSpawner(
    options.spawnFailure !== undefined ? { failure: options.spawnFailure } : {},
  )
  const sleeps: number[] = []
  let nextPort = 9001
  // The probe answers as the process that actually bound the port would: it finds the
  // spawn whose args carry that port and echoes THAT child's host token.
  const probedUrls: string[] = []
  const probe: HealthProbe = async (url: string) => {
    probedUrls.push(url)
    if (options.probeGate !== undefined) await options.probeGate
    const port = new URL(url).port
    const call = spawner.calls.find((c) => c.args.includes(port))
    return {
      ok: options.probeOk ?? true,
      token: options.probeToken ?? call?.env.SPECTRUM_TOKEN,
    }
  }
  let clock = 0
  let mintedTokens = 0
  const providerHost = createProviderHost({
    registry: gatedRegistry(
      fakeRegistry(options.contributions ?? [contribution()]),
      options.registryGate,
    ),
    resolver: createFakeCommandResolver({
      "acme-server": "/opt/acme/bin/acme-server",
    }),
    spawner,
    allocator: { allocate: async () => ok(nextPort++) },
    probe,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      if (options.sleepGate !== undefined) await options.sleepGate
    },
    now: () => {
      clock += options.clockStepMs ?? 5000
      return clock
    },
    tokenGen: () => {
      mintedTokens += 1
      return `tok-${mintedTokens}`
    },
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.maxRestarts !== undefined
      ? { maxRestarts: options.maxRestarts }
      : {}),
  })
  return { host: providerHost, spawner, sleeps, probedUrls }
}

describe("createProviderHost", () => {
  it("spawns the resolved command with rendered args when first asked to run", async () => {
    const { host: h, spawner } = host()
    const result = await h.ensureRunning(run())
    expect(result.ok).toBe(true)
    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]?.command).toBe("/opt/acme/bin/acme-server")
    expect(spawner.calls[0]?.args).toEqual([
      "--port",
      "9001",
      "--base",
      "http://127.0.0.1:9001",
    ])
    if (result.ok) {
      expect(result.value).toEqual({
        baseUrl: "http://127.0.0.1:9001",
        pid: 100,
        hostToken: "tok-1",
      })
    }
    expect(h.status("k1")).toBe("running")
  })

  it("injects only the declared secrets into the child env", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    expect(spawner.calls[0]?.env).toEqual({
      ACME_KEY: "sk-x",
      SPECTRUM_TOKEN: "tok-1",
    })
  })

  it("passes a freshly minted host token to each spawned instance", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run("acme", "k1"))
    await h.ensureRunning(run("acme", "k2"))
    expect(spawner.calls[0]?.env.SPECTRUM_TOKEN).not.toBe(
      spawner.calls[1]?.env.SPECTRUM_TOKEN,
    )
  })

  it("fails when the plugin answers readiness with the wrong host token", async () => {
    const { host: h } = host({ probeToken: "impostor" })
    const result = await h.ensureRunning(run())
    expect(result.ok).toBe(false)
    expect(h.status("k1")).toBe("failed")
  })

  it("spawns exactly once when two callers race on the same instance key", async () => {
    const { host: h, spawner } = host()
    const [a, b] = await Promise.all([
      h.ensureRunning(run()),
      h.ensureRunning(run()),
    ])
    expect(spawner.calls).toHaveLength(1)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value).toEqual(b.value)
  })

  it("reuses the running process when asked again after a successful start", async () => {
    const { host: h, spawner } = host()
    const first = await h.ensureRunning(run())
    const second = await h.ensureRunning(run())
    expect(spawner.calls).toHaveLength(1)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.value).toEqual(first.value)
  })

  it("spawns a second process when two instance keys target the same contribution", async () => {
    const { host: h, spawner } = host()
    const a = await h.ensureRunning(run("acme", "k1", "sk-a"))
    const b = await h.ensureRunning(run("acme", "k2", "sk-b"))
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.calls[0]?.env.ACME_KEY).toBe("sk-a")
    expect(spawner.calls[1]?.env.ACME_KEY).toBe("sk-b")
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value.baseUrl).not.toBe(b.value.baseUrl)
  })

  it("fails and marks the instance failed when readiness never succeeds", async () => {
    const { host: h } = host({ probeOk: false })
    const result = await h.ensureRunning(run())
    expect(result.ok).toBe(false)
    expect(h.status("k1")).toBe("failed")
  })

  it("fails with not-found when no contribution claims the id", async () => {
    const { host: h, spawner } = host()
    const result = await h.ensureRunning(run("ghost", "k9"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("not-found")
    expect(spawner.calls).toHaveLength(0)
  })

  it("fails with invalid-manifest when the contribution declares no launch block", async () => {
    const { host: h, spawner } = host({
      contributions: [contribution({ noLaunch: true })],
    })
    const result = await h.ensureRunning(run())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid-manifest")
    expect(spawner.calls).toHaveLength(0)
  })

  it("reports starting while the first start is still in flight", async () => {
    const ready = gate()
    const { host: h } = host({ probeGate: ready.promise })
    const pending = h.ensureRunning(run())
    await flush()
    expect(h.status("k1")).toBe("starting")
    ready.open()
    await pending
    expect(h.status("k1")).toBe("running")
  })

  it("kills the child and stays stopped when a stop lands mid-start", async () => {
    const listing = gate()
    const { host: h, spawner } = host({ registryGate: listing.promise })
    const pending = h.ensureRunning(run())
    await flush()
    // The start is suspended inside registry.list(): nothing has spawned yet, so stop has
    // no process to kill — the child it orphans would appear only afterwards.
    expect(spawner.calls).toHaveLength(0)
    await h.stop("k1")
    listing.open()
    const result = await pending
    await flush()
    expect(result.ok).toBe(false)
    expect(h.status("k1")).toBe("stopped")
    expect(spawner.kills).toEqual([100])
  })

  it("never health-probes the orphan a mid-start stop leaves behind", async () => {
    const listing = gate()
    const {
      host: h,
      spawner,
      probedUrls,
    } = host({
      registryGate: listing.promise,
    })
    const pending = h.ensureRunning(run())
    await flush()
    await h.stop("k1")
    listing.open()
    await pending
    await flush()
    // The superseded start must bail at the spawn, not wait out a readiness deadline on a
    // process it is about to kill — and must never write its port onto the stopped instance.
    expect(probedUrls).toEqual([])
    expect(spawner.kills).toEqual([100])
  })

  it("keeps exactly one live process when ensureRunning follows a stop that landed mid-start", async () => {
    const listing = gate()
    const { host: h, spawner } = host({ registryGate: listing.promise })
    const first = h.ensureRunning(run())
    await flush()
    await h.stop("k1")
    const second = h.ensureRunning(run())
    listing.open()
    const [a, b] = await Promise.all([first, second])
    await flush()
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(true)
    // Both starts spawned, but the superseded one killed its own child rather than
    // leaving a second untracked process bound to a second port.
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.kills).toEqual([100])
    if (b.ok) expect(b.value.pid).toBe(101)
    expect(h.status("k1")).toBe("running")
  })

  it("does not spawn a replacement when a stop lands during the restart backoff", async () => {
    const backoff = gate()
    const { host: h, spawner } = host({ sleepGate: backoff.promise })
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    // The restart is parked in sleep(backoff) — the window a shutdown lands in.
    expect(spawner.calls).toHaveLength(1)
    await h.stop("k1")
    backoff.open()
    await flush()
    expect(spawner.calls).toHaveLength(1)
    expect(h.status("k1")).toBe("stopped")
  })

  it("restores the full restart budget after the plugin has run stably", async () => {
    // A one-minute clock step makes every instance's uptime exceed the stability window,
    // so each crash is an isolated incident rather than part of a crash loop.
    const { host: h, spawner } = host({ maxRestarts: 1, clockStepMs: 60_000 })
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    spawner.children[1]?.exit(1)
    await flush()
    expect(spawner.calls).toHaveLength(3)
    expect(h.status("k1")).toBe("running")
  })

  it("reports stopped after stop is called on a running instance", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    await h.stop("k1")
    expect(h.status("k1")).toBe("stopped")
    expect(spawner.kills).toEqual([100])
  })

  it("stops every instance of a contribution when stopAllFor is called", async () => {
    const { host: h } = host()
    await h.ensureRunning(run("acme", "k1"))
    await h.ensureRunning(run("acme", "k2"))
    await h.stopAllFor("acme")
    expect(h.status("k1")).toBe("stopped")
    expect(h.status("k2")).toBe("stopped")
  })

  it("stops every supervised instance when stopAll is called", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run("acme", "k1"))
    await h.ensureRunning(run("acme", "k2"))
    await h.stopAll()
    expect(spawner.kills).toEqual([100, 101])
    expect(h.status("k1")).toBe("stopped")
    expect(h.status("k2")).toBe("stopped")
  })

  it("reports stopped for an instance key that was never started", () => {
    const { host: h } = host()
    expect(h.status("never")).toBe("stopped")
  })

  it("restarts the plugin with a new port and a new host token after an unexpected exit", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.calls[1]?.args).toEqual([
      "--port",
      "9002",
      "--base",
      "http://127.0.0.1:9002",
    ])
    expect(spawner.calls[1]?.env.SPECTRUM_TOKEN).not.toBe(
      spawner.calls[0]?.env.SPECTRUM_TOKEN,
    )
    expect(h.status("k1")).toBe("running")
  })

  it("serves the restarted process's base url and pid from the next ensureRunning", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    const after = await h.ensureRunning(run())
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.value.baseUrl).toBe("http://127.0.0.1:9002")
      expect(after.value.pid).toBe(101)
    }
    expect(spawner.calls).toHaveLength(2)
  })

  it("backs off longer before each successive restart", async () => {
    const { host: h, spawner, sleeps } = host({ maxRestarts: 3 })
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    spawner.children[1]?.exit(1)
    await flush()
    expect(sleeps).toHaveLength(2)
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0)
  })

  it("marks the instance failed once the restart budget is exhausted", async () => {
    const { host: h, spawner } = host({ maxRestarts: 2 })
    await h.ensureRunning(run())
    for (let i = 0; i < 3; i += 1) {
      spawner.children[i]?.exit(1)
      await flush()
    }
    expect(spawner.calls).toHaveLength(3)
    expect(h.status("k1")).toBe("failed")
  })

  it("does not restart the plugin when the exit follows a stop", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    await h.stop("k1")
    await flush()
    expect(spawner.calls).toHaveLength(1)
    expect(h.status("k1")).toBe("stopped")
  })

  it("does not restart the plugin when readiness fails and the child then exits", async () => {
    const { host: h, spawner } = host({ probeOk: false })
    await h.ensureRunning(run())
    await flush()
    expect(spawner.calls).toHaveLength(1)
    expect(h.status("k1")).toBe("failed")
  })

  it("starts a stopped instance again when ensureRunning is called after stop", async () => {
    const { host: h, spawner } = host()
    await h.ensureRunning(run())
    await h.stop("k1")
    const again = await h.ensureRunning(run())
    expect(again.ok).toBe(true)
    expect(spawner.calls).toHaveLength(2)
    expect(h.status("k1")).toBe("running")
  })

  it("fails with write-failed when the spawner cannot start the process", async () => {
    const { host: h } = host({
      spawnFailure: { kind: "spawn-failed", detail: "ENOENT" },
    })
    const result = await h.ensureRunning(run())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("write-failed")
    expect(h.status("k1")).toBe("failed")
  })

  it("logs the spawn with env keys and UNRENDERED args, plus the ready port", async () => {
    const logger = createFakeLogger()
    const { host: h } = host({ logger })
    await h.ensureRunning(run())
    const spawnLog = logger.records.find((r) => r.fields?.envKeys !== undefined)
    expect(spawnLog?.level).toBe("info")
    expect(spawnLog?.fields).toEqual({
      providerId: "acme",
      command: "/opt/acme/bin/acme-server",
      args: ["--port", "{{port}}", "--base", "{{baseUrl}}"],
      envKeys: ["ACME_KEY", "SPECTRUM_TOKEN"],
    })
    const readyLog = logger.records.find((r) => r.fields?.port !== undefined)
    expect(readyLog?.level).toBe("info")
    expect(readyLog?.fields).toEqual({ providerId: "acme", port: 9001 })
  })

  it("never logs a secret that the manifest renders into an ARG", async () => {
    const logger = createFakeLogger()
    const { host: h } = host({
      logger,
      contributions: [contribution({ secretInArgs: true })],
    })
    await h.ensureRunning(run("acme", "k1", "sk-in-an-arg"))
    expect(JSON.stringify(logger.records)).not.toContain("sk-in-an-arg")
  })

  it("never logs the host token, a secret value, or the instance key", async () => {
    const logger = createFakeLogger()
    const { host: h, spawner } = host({ logger, maxRestarts: 1 })
    await h.ensureRunning(run("acme", "secret-instance-key", "sk-super"))
    spawner.children[0]?.exit(1)
    await flush()
    spawner.children[1]?.exit(1)
    await flush()
    const serialized = JSON.stringify(logger.records)
    expect(serialized).not.toContain("tok-1")
    expect(serialized).not.toContain("tok-2")
    expect(serialized).not.toContain("sk-super")
    expect(serialized).not.toContain("secret-instance-key")
  })

  it("warns on restart and errors when the restart budget is exhausted", async () => {
    const logger = createFakeLogger()
    const { host: h, spawner } = host({ logger, maxRestarts: 1 })
    await h.ensureRunning(run())
    spawner.children[0]?.exit(1)
    await flush()
    spawner.children[1]?.exit(1)
    await flush()
    expect(logger.records.filter((r) => r.level === "warn")).toHaveLength(1)
    expect(logger.records.filter((r) => r.level === "error")).toHaveLength(1)
  })

  it("errors when readiness never succeeds", async () => {
    const logger = createFakeLogger()
    const { host: h } = host({ logger, probeOk: false })
    await h.ensureRunning(run())
    expect(logger.records.filter((r) => r.level === "error")).toHaveLength(1)
  })
})
