import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import {
  createDirExtensionFileSource,
  createExtensionRegistry,
} from "@spectrum/extensions"
import type { PluginError } from "@spectrum/extensions"
import {
  createBunProcessSpawner,
  createPathCommandResolver,
} from "@spectrum/proc"
import type { FlowRunnerDeps, RunnerStep } from "@spectrum/provider-host"
import {
  createCryptoTokenGen,
  createFetchFlowHttp,
  createFetchHealthProbe,
  createFlowClient,
  createFlowRunner,
  createLoopbackPortAllocator,
  createProviderHost,
} from "@spectrum/provider-host"
import { createProviderRegistry } from "@spectrum/providers"
import {
  createProviderFactory,
  createRealGateway,
  loadSdk,
} from "@spectrum/proxy"
import {
  createInMemoryKeychainBackend,
  createSecretStore,
} from "@spectrum/secrets"
import type { Provider } from "@spectrum/types"
import { PluginIdSchema, ProviderIdSchema } from "@spectrum/types"
import {
  type Result,
  createCryptoIdGen,
  createSystemClock,
} from "@spectrum/utils"
import type { AppContext } from "./app-context"
import { createAppContext } from "./create-app-context"
import { buildFakeAppContextDeps } from "./test-support"

/**
 * A provider setup flow against a REAL child process, through the REAL composition root.
 *
 * Every other test in this plan runs against fakes. This one wires the production
 * `createAppContext` — its own `resolveBaseUrl`, its own retention sweep, its own flow-runner
 * deps — over the real `createFlowRunner`, `createFlowClient`, `createFetchFlowHttp`,
 * `createProviderHost`, `createBunProcessSpawner`, `createLoopbackPortAllocator` and
 * `createFetchHealthProbe`, and points it at a hand-written manifest on disk whose launch block
 * spawns `fixtures/oauth-extension-server.ts`.
 *
 * REAL: the composition root, the extension file source + registry, the provider registry, the
 * provider host (spawner, loopback port allocation, host-token generation, fetch readiness
 * probe), the flow runner + client + HTTP adapter, the secret store, the provider factory, the
 * streaming gateway, the model lister behind `listProviderModels`, and the child process.
 *
 * FAKED, and why: the SQLite client / session store / run store / harness registry / driver
 * layer (stubs from `buildFakeAppContextDeps` — no flow path touches them); the config FILE
 * (a cell, so a test can hand the sweep an exact config without an fs round trip — the store
 * wrapper that triggers the sweep is the composition root's own); the keychain BACKEND (in
 * memory — the real one prompts and pollutes the developer's OS keychain; the `SecretStore`
 * logic over it is real); and, in one case only, the flow deadline's timer, so the runner's
 * 10-minute budget can be observed without waiting 10 minutes.
 *
 * The fixture VALIDATES what Spectrum sends it (401 without the host token, 400 on a malformed
 * `start`/`next` body or a session id it never minted). A fixture that answered every request
 * would prove only that a URL was reachable.
 */

const FIXTURE = join(import.meta.dir, "fixtures", "oauth-extension-server.ts")

/** The contribution id, and therefore the `plugin:` descriptor key and the flow key's middle. */
const CONTRIBUTION_ID = "oauth-demo"
const PROVIDER_KEY = `plugin:${CONTRIBUTION_ID}`

/**
 * The credential the fake identity provider grants. Declared HERE and rendered into the child's
 * env by the manifest, so the fixture hardcodes no secret and the value the test asserts on is
 * the same one the plugin hands back.
 */
const GRANTED_API_KEY = "sk-from-oauth"
const GRANTED_ACCOUNT_ID = "acct-42"

/** Long enough for a cold `bun <file>` start on a loaded CI machine. */
const READY_TIMEOUT_MS = 20_000

const manifest = (): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id: CONTRIBUTION_ID,
  name: "OAuth demo",
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: CONTRIBUTION_ID,
        descriptor: {
          label: "OAuth demo",
          configFields: [
            {
              name: "accountId",
              label: "Account",
              kind: "text",
              required: false,
            },
          ],
          // Declared so `{{apiKey}}` is a legal launch template token: the host renders the
          // provider record's RESOLVED secrets into the child's environment, which is how the
          // credential this flow granted reaches the serving process.
          secretFields: [{ name: "apiKey", label: "API key", required: false }],
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "openai-models" },
          actions: [
            {
              kind: "flow",
              id: "signin",
              label: "Sign in with the demo IdP",
              context: "both",
            },
          ],
        },
        transport: {
          kind: "http",
          wire: "openai",
          launch: {
            command: process.execPath,
            args: [FIXTURE, "--port", "{{port}}"],
            envTemplate: {
              SPECTRUM_TOKEN: "{{hostToken}}",
              SPECTRUM_API_KEY: "{{apiKey}}",
              SPECTRUM_GRANTED_API_KEY: GRANTED_API_KEY,
              SPECTRUM_GRANTED_ACCOUNT_ID: GRANTED_ACCOUNT_ID,
            },
            // Root-relative: the host hands the factory a bare `http://127.0.0.1:<port>`.
            healthPath: "/models",
            readyTimeoutMs: READY_TIMEOUT_MS,
          },
        },
      },
    ],
  },
})

/** A config with the fixture extension installed as a linked path install and enabled. */
const configWith = (input: {
  readonly extensionDir: string
  readonly enabled: boolean
  readonly providers?: readonly Provider[]
}): Config => ({
  ...defaultConfig(),
  providers: [...(input.providers ?? [])],
  providerPlugins: [
    {
      id: PluginIdSchema.parse(CONTRIBUTION_ID),
      // `linked` reads the extension LIVE from its directory, so the test never has to
      // reproduce the composition root's own plugin-root path derivation.
      source: { kind: "path", path: input.extensionDir, linked: true },
      enabled: input.enabled,
    },
  ],
})

type Harness = {
  readonly ctx: AppContext
  /** Where the linked manifest lives, so a case can rebuild the same config it was given. */
  readonly extensionDir: string
}

/** Every harness built by the current test, torn down unconditionally in `afterEach`. */
const live: Array<{ readonly ctx: AppContext; readonly home: string }> = []

const buildHarness = async (
  options: { readonly flowDeadlineMs?: number } = {},
): Promise<Harness> => {
  const home = await mkdtemp(join(tmpdir(), "spectrum-flow-e2e-"))
  const extensionDir = join(home, "extension")
  await mkdir(extensionDir, { recursive: true })
  await writeFile(
    join(extensionDir, "spectrum-extension.json"),
    JSON.stringify(manifest(), null, 2),
    "utf8",
  )

  let current = configWith({ extensionDir, enabled: true })

  const deps = buildFakeAppContextDeps({
    homeDir: () => home,
    platform: "linux",
    env: { SPECTRUM_LOG_LEVEL: "error" },
    ensureDir: (dir: string) => {
      mkdirSync(dir, { recursive: true })
    },
    createCachedConfigStore: (() => ({
      load: async () => ({ ok: true, value: current }) as const,
      save: async (next: Config) => {
        current = next
        return { ok: true, value: undefined } as const
      },
    })) as never,
    // The keychain BACKEND is in memory; the `SecretStore` over it is production code.
    createPlatformKeychainBackend: (() =>
      createInMemoryKeychainBackend()) as never,
    createSecretStore: createSecretStore as never,
    createCryptoIdGen: createCryptoIdGen as never,
    createSystemClock: createSystemClock as never,
    createDirExtensionFileSource: createDirExtensionFileSource as never,
    createExtensionRegistry: createExtensionRegistry as never,
    createProviderRegistry: createProviderRegistry as never,
    createPathCommandResolver: createPathCommandResolver as never,
    createBunProcessSpawner: createBunProcessSpawner as never,
    createProviderHost: createProviderHost as never,
    createLoopbackPortAllocator: createLoopbackPortAllocator as never,
    createFetchHealthProbe: createFetchHealthProbe as never,
    createCryptoTokenGen: createCryptoTokenGen as never,
    createFetchFlowHttp: createFetchFlowHttp as never,
    createFlowClient: createFlowClient as never,
    // The REAL runner. Only its injected deadline timer is compressed, and only when a case
    // asks for it: the budget the runner enforces is 10 minutes, which no test can wait out.
    createFlowRunner: ((runnerDeps: FlowRunnerDeps) =>
      createFlowRunner(
        options.flowDeadlineMs === undefined
          ? runnerDeps
          : {
              ...runnerDeps,
              setTimer: (_ms: number, onFire: () => void) =>
                setTimeout(onFire, options.flowDeadlineMs),
            },
      )) as never,
    createProviderFactory: createProviderFactory as never,
    createRealGateway: createRealGateway as never,
    loadSdk,
  })

  const ctx = createAppContext(deps)
  live.push({ ctx, home })
  // The constructor kicks off its own refresh; awaiting a second one guarantees the linked
  // manifest has been read before the first flow starts.
  await ctx.refreshExtensions()
  return { ctx, extensionDir }
}

// UNCONDITIONAL: a failing assertion must never leave a spawned plugin process behind.
afterEach(async () => {
  const built = [...live]
  live.length = 0
  for (const { ctx, home } of built) {
    await ctx.providerHost.stopAll()
    await rm(home, { recursive: true, force: true })
  }
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll the process table until `pid` is gone, so a kill that never happens fails loudly. */
const awaitProcessGone = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

/** The loopback port of the child serving a flow, read out of the url it asked us to open. */
const portOf = (url: string): number => Number(new URL(url).port)

/** Ask the child which OS process it is, so its death can be checked against the OS. */
const pidOf = async (port: number): Promise<number> => {
  const response = await fetch(`http://127.0.0.1:${port}/pid`)
  const body = (await response.json()) as { readonly pid: number }
  return body.pid
}

/**
 * What a running child lists at its health/discovery path. The fixture reports `oauth-1` only
 * when its ENVIRONMENT carries the granted credential, so this reads what Spectrum actually
 * put in that process's environment — from outside the process, and without believing anything
 * Spectrum says about itself.
 */
const modelIdsOf = async (port: number): Promise<readonly string[]> => {
  const response = await fetch(`http://127.0.0.1:${port}/models`)
  const body = (await response.json()) as {
    readonly data: readonly { readonly id: string }[]
  }
  return body.data.map((m) => m.id)
}

/** The host token a running child was handed, read back out of the header it echoes. */
const hostTokenOf = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}/models`)
  return response.headers.get("x-spectrum-host-token") ?? ""
}

const startInput = (flowId = "signin") =>
  ({
    providerId: CONTRIBUTION_ID,
    flowId,
    context: "create",
    config: {},
  }) as const

const unwrap = (step: Result<RunnerStep, PluginError>): RunnerStep => {
  if (!step.ok) throw new Error(`flow step failed: ${step.error.kind}`)
  return step.value
}

/**
 * Run the whole exchange: authorize in the "browser", acknowledge, then poll until the plugin
 * reports `done`. Returns the last step so a caller can assert on it.
 */
const completeFlow = async (
  ctx: AppContext,
  first: RunnerStep,
): Promise<Result<RunnerStep, PluginError>> => {
  if (first.step.kind === "open-external") await fetch(first.step.url)
  let step = await ctx.flowRunner.advance({
    sessionId: first.sessionId,
    result: { kind: "ack" },
  })
  for (let i = 0; i < 10 && step.ok && step.value.step.kind === "await"; i += 1)
    step = await ctx.flowRunner.advance({
      sessionId: first.sessionId,
      result: { kind: "poll" },
    })
  return step
}

describe("extension setup flow, end to end", () => {
  it("completes an oauth-shaped flow and yields the credentials the plugin granted", async () => {
    const { ctx } = await buildHarness()

    const first = await ctx.flowRunner.start(startInput())
    expect(first.ok).toBe(true)
    const opened = unwrap(first)
    expect(opened.step.kind).toBe("open-external")
    if (opened.step.kind !== "open-external") return

    // Acknowledged BEFORE the redirect: consent has not happened yet, so the plugin must ask
    // us to wait — the branch a test that redirects first never reaches.
    const waiting = await ctx.flowRunner.advance({
      sessionId: opened.sessionId,
      result: { kind: "ack" },
    })
    expect(unwrap(waiting).step.kind).toBe("await")

    // Stands in for the OS browser: the fixture's own IdP endpoint receives the redirect,
    // exactly as a real browser would hit the extension's loopback callback.
    await fetch(opened.step.url)

    const done = await ctx.flowRunner.advance({
      sessionId: opened.sessionId,
      result: { kind: "poll" },
    })
    expect(unwrap(done).step.kind).toBe("done")

    const completion = ctx.flowRunner.takeCompletion(opened.sessionId)
    expect(completion?.secrets.apiKey).toBe(GRANTED_API_KEY)
    expect(completion?.config.accountId).toBe(GRANTED_ACCOUNT_ID)
    // Drained by exactly one read, so a replayed IPC call cannot re-read the credential.
    expect(ctx.flowRunner.takeCompletion(opened.sessionId)).toBeUndefined()
  }, 60_000)

  it("clamps an await step's poll interval to Spectrum's floor rather than the plugin's number", async () => {
    const { ctx } = await buildHarness()
    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    // Passed through untouched from the plugin's response, so the GUI can show it.
    expect(opened.toast).toEqual({
      tone: "info",
      message: "Opening your browser",
    })

    const waiting = unwrap(
      await ctx.flowRunner.advance({
        sessionId: opened.sessionId,
        result: { kind: "ack" },
      }),
    )
    expect(waiting.step.kind).toBe("await")
    if (waiting.step.kind !== "await") return
    // The plugin asked for 10 ms. A UI that trusted it would poll at the plugin's rate.
    expect(waiting.step.pollMs).toBe(500)
  }, 60_000)

  it("contributes the flow action the providers page offers", async () => {
    const { ctx } = await buildHarness()
    const entry = ctx.providerRegistry
      .catalog()
      .find((e) => String(e.key) === PROVIDER_KEY)
    expect(entry?.actions).toContainEqual({
      kind: "flow",
      id: "signin",
      label: "Sign in with the demo IdP",
      context: "both",
    })
  }, 60_000)

  it("runs the flow on a dedicated child and kills that process once the flow completes", async () => {
    const { ctx } = await buildHarness()

    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")

    // Captured while the flow is LIVE. Asserting only the post-conditions would pass on a
    // typo'd key: `status` answers "stopped" for a swept instance, a crashed one, and a key
    // that never existed alike. The transition is the property.
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    expect(flowKey).toMatch(new RegExp(`^flow:${CONTRIBUTION_ID}:.+`))
    expect(ctx.providerHost.status(flowKey)).toBe("running")
    const pid = await pidOf(portOf(opened.step.url))
    expect(isAlive(pid)).toBe(true)

    expect(unwrap(await completeFlow(ctx, opened)).step.kind).toBe("done")

    expect([...ctx.flowRunner.activeInstanceKeys()]).toEqual([])
    expect(ctx.providerHost.status(flowKey)).toBe("stopped")
    // The OS, not Spectrum's own bookkeeping: the child was killed, not merely forgotten.
    expect(await awaitProcessGone(pid)).toBe(true)
  }, 60_000)

  it("keeps two concurrent flows for one contribution on separate children with separate host tokens", async () => {
    const { ctx } = await buildHarness()

    const a = unwrap(await ctx.flowRunner.start(startInput()))
    const b = unwrap(await ctx.flowRunner.start(startInput()))
    if (a.step.kind !== "open-external" || b.step.kind !== "open-external")
      throw new Error("no redirect")
    expect(a.sessionId).not.toBe(b.sessionId)
    expect([...ctx.flowRunner.activeInstanceKeys()]).toHaveLength(2)

    const portA = portOf(a.step.url)
    const portB = portOf(b.step.url)
    const pidA = await pidOf(portA)
    const pidB = await pidOf(portB)
    expect(pidA).not.toBe(pidB)
    // A shared token would make one flow's credential exchange addressable by the other's
    // holder; a fresh child gets a fresh one.
    const tokenA = await hostTokenOf(portA)
    expect(tokenA).not.toBe("")
    expect(tokenA).not.toBe(await hostTokenOf(portB))

    // Cancelling one must not touch the other — that is what the key's nonce is for.
    await ctx.flowRunner.cancel(a.sessionId)
    expect(await awaitProcessGone(pidA)).toBe(true)
    expect(isAlive(pidB)).toBe(true)
    expect(unwrap(await completeFlow(ctx, b)).step.kind).toBe("done")
  }, 60_000)

  it("withholds the caller's secrets from a create-context flow's child and hands them to a provider-context one", async () => {
    const { ctx } = await buildHarness()

    // SECURITY: a provider being CREATED has no record yet, so the secrets a caller passes are
    // not this contribution's — rendering them into the child's environment would hand a
    // plugin credentials the user never associated with it.
    const creating = unwrap(
      await ctx.flowRunner.start({
        ...startInput(),
        secrets: { apiKey: GRANTED_API_KEY },
      }),
    )
    if (creating.step.kind !== "open-external") throw new Error("no redirect")
    expect(await modelIdsOf(portOf(creating.step.url))).toEqual([
      "unauthenticated",
    ])

    // Managing an EXISTING provider is the opposite case: the flow's child is that provider's,
    // so it must be started with that provider's resolved secrets.
    const managing = unwrap(
      await ctx.flowRunner.start({
        providerId: CONTRIBUTION_ID,
        flowId: "signin",
        context: "provider",
        config: {},
        secrets: { apiKey: GRANTED_API_KEY },
      }),
    )
    if (managing.step.kind !== "open-external") throw new Error("no redirect")
    expect(await modelIdsOf(portOf(managing.step.url))).toEqual(["oauth-1"])
  }, 60_000)

  it("kills the flow's child when the user cancels mid-flow", async () => {
    const { ctx } = await buildHarness()

    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    const pid = await pidOf(portOf(opened.step.url))
    expect(ctx.providerHost.status(flowKey)).toBe("running")

    // What closing the setup modal does.
    await ctx.flowRunner.cancel(opened.sessionId)

    expect(ctx.providerHost.status(flowKey)).toBe("stopped")
    expect([...ctx.flowRunner.activeInstanceKeys()]).toEqual([])
    expect(await awaitProcessGone(pid)).toBe(true)
    // A cancelled flow is over: a later step gets `not-found`, not a live exchange.
    const after = await ctx.flowRunner.advance({
      sessionId: opened.sessionId,
      result: { kind: "poll" },
    })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("not-found")
  }, 60_000)

  it("kills the flow's child when the total-timeout deadline fires on a flow that never answers", async () => {
    // The runner's real budget is 10 minutes; only the injected timer is compressed. The
    // deadline is armed the moment the child is ready, so this has to outlast the opening
    // exchange (a few loopback round trips) by a wide margin on a loaded machine.
    const { ctx } = await buildHarness({ flowDeadlineMs: 1500 })

    const opened = unwrap(await ctx.flowRunner.start(startInput("hang")))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    expect(ctx.providerHost.status(flowKey)).toBe("running")
    const pid = await pidOf(portOf(opened.step.url))

    // The plugin accepts this call and never answers it. Nothing but the armed deadline can
    // end the flow — the elapsed-budget check is only read when a call RETURNS.
    const hung = await ctx.flowRunner.advance({
      sessionId: opened.sessionId,
      result: { kind: "ack" },
    })
    expect(hung.ok).toBe(false)
    // The deadline ends the session while this call is suspended, so the call that WAS in
    // flight comes back `not-found` rather than naming the timeout. Pinned as the observed
    // behaviour, not endorsed: `flow-errors.ts` renders `not-found` as "this extension does
    // not offer that setup flow, or the flow has already ended (<id>)" — misleading copy for
    // a timeout, and the `<id>` it prints here is the Spectrum-side session handle.
    if (!hung.ok) expect(hung.error.kind).toBe("not-found")
    expect(ctx.providerHost.status(flowKey)).toBe("stopped")
    expect([...ctx.flowRunner.activeInstanceKeys()]).toEqual([])
    expect(await awaitProcessGone(pid)).toBe(true)
  }, 60_000)

  it("kills the flow's child when the plugin keeps returning steps past the cap", async () => {
    const { ctx } = await buildHarness()

    const opened = unwrap(await ctx.flowRunner.start(startInput("endless")))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    expect(ctx.providerHost.status(flowKey)).toBe("running")
    const pid = await pidOf(portOf(opened.step.url))

    let delivered = 1 // the `start` step
    let failure: PluginError | undefined
    for (let i = 0; i < 80; i += 1) {
      const step = await ctx.flowRunner.advance({
        sessionId: opened.sessionId,
        result: { kind: "poll" },
      })
      if (!step.ok) {
        failure = step.error
        break
      }
      delivered += 1
    }

    expect(failure?.kind).toBe("read-failed")
    expect(failure).toMatchObject({ detail: "flow exceeded 50 steps" })
    // Spectrum's cap, not the plugin's: the plugin would have gone on forever.
    expect(delivered).toBe(50)
    expect(ctx.providerHost.status(flowKey)).toBe("stopped")
    expect([...ctx.flowRunner.activeInstanceKeys()]).toEqual([])
    expect(await awaitProcessGone(pid)).toBe(true)
  }, 60_000)

  it("discovers the models of the provider the flow's credentials produced", async () => {
    const { ctx, extensionDir } = await buildHarness()
    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    expect(unwrap(await completeFlow(ctx, opened)).step.kind).toBe("done")
    const completion = ctx.flowRunner.takeCompletion(opened.sessionId)
    if (completion === undefined) throw new Error("flow produced no completion")

    // Exactly what the GUI's flow handler persists: each secret VALUE to the keychain, only
    // the returned ref into the config.
    const ref = await ctx.secrets.set(completion.secrets.apiKey ?? "")
    expect(ref.ok).toBe(true)
    if (!ref.ok) return
    const provider: Provider = {
      id: ProviderIdSchema.parse("p_oauth"),
      name: "OAuth demo",
      sdkProvider: PROVIDER_KEY,
      config: { ...completion.config },
      secrets: { apiKey: ref.value },
      models: [],
    }
    const saved = await ctx.config.save({
      ...configWith({ extensionDir, enabled: true, providers: [provider] }),
    })
    expect(saved.ok).toBe(true)

    const models = await ctx.listProviderModels(String(provider.id))
    expect(models.ok).toBe(true)
    if (!models.ok) return
    // The fixture lists `oauth-1` only when its environment carries the key the flow granted,
    // so this id is proof the credential survived the keychain round trip into the child.
    expect(models.value.map((m) => m.id)).toEqual(["oauth-1"])
  }, 60_000)

  it("streams from the provider the flow produced", async () => {
    const { ctx, extensionDir } = await buildHarness()
    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    expect(unwrap(await completeFlow(ctx, opened)).step.kind).toBe("done")
    const completion = ctx.flowRunner.takeCompletion(opened.sessionId)
    if (completion === undefined) throw new Error("flow produced no completion")

    const ref = await ctx.secrets.set(completion.secrets.apiKey ?? "")
    if (!ref.ok) throw new Error("keychain refused the credential")
    const provider: Provider = {
      id: ProviderIdSchema.parse("p_oauth"),
      name: "OAuth demo",
      sdkProvider: PROVIDER_KEY,
      config: { ...completion.config },
      secrets: { apiKey: ref.value },
      models: [],
    }
    const saved = await ctx.config.save(
      configWith({ extensionDir, enabled: true, providers: [provider] }),
    )
    expect(saved.ok).toBe(true)

    const descriptor = ctx.providerRegistry.get(PROVIDER_KEY)
    if (descriptor === undefined) throw new Error("no descriptor contributed")
    const model = await ctx.factory.getModel(provider, "oauth-1")
    expect(model.ok).toBe(true)
    if (!model.ok) return

    const chunks: string[] = []
    for await (const event of ctx.gateway.stream(
      model.value,
      {
        model: "oauth-1",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      },
      { descriptor, providerModel: "oauth-1" },
    )) {
      if (event.type === "text-delta") chunks.push(event.text)
      if (event.type === "error")
        throw new Error(`gateway error: ${event.detail}`)
    }
    expect(chunks.join("")).toContain("hello")
  }, 60_000)

  it("keeps a live flow's child running when an unrelated provider is saved", async () => {
    const { ctx, extensionDir } = await buildHarness()
    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    const pid = await pidOf(portOf(opened.step.url))

    // The composition root's OWN sweep, driven by a save the user could make in another
    // window mid-flow. A flow key belongs to no provider record, so an unswept union here
    // would kill the child holding the half-finished credential exchange.
    const saved = await ctx.config.save(
      configWith({
        extensionDir,
        enabled: true,
        providers: [
          {
            id: ProviderIdSchema.parse("p_unrelated"),
            name: "Unrelated",
            sdkProvider: PROVIDER_KEY,
            config: { accountId: "other" },
            secrets: {},
            models: [],
          },
        ],
      }),
    )
    expect(saved.ok).toBe(true)

    expect(ctx.providerHost.status(flowKey)).toBe("running")
    expect(isAlive(pid)).toBe(true)
    // Still usable, not merely still alive.
    expect(unwrap(await completeFlow(ctx, opened)).step.kind).toBe("done")
  }, 60_000)

  it("names the disable rather than the supervisor's error when the extension is disabled while the flow is still spawning", async () => {
    const { ctx, extensionDir } = await buildHarness()

    // NOT awaited: `start` registers its instance key synchronously and then spends real time
    // spawning and probing a child, which is exactly the window a sweep can land in. The
    // supervisor's own failure in that window is CAUSED by the sweep, so reporting it would
    // send the user hunting a bug that is their own click.
    const starting = ctx.flowRunner.start(startInput())
    const saved = await ctx.config.save(
      configWith({ extensionDir, enabled: false }),
    )
    expect(saved.ok).toBe(true)

    const outcome = unwrap(await starting)
    expect(outcome.step.kind).toBe("error")
    if (outcome.step.kind !== "error") return
    expect(outcome.step.message).toContain("no longer available")
    expect([...ctx.flowRunner.activeInstanceKeys()]).toEqual([])
  }, 60_000)

  it("stops a live flow's child and names why when its extension is disabled mid-flow", async () => {
    const { ctx, extensionDir } = await buildHarness()
    const opened = unwrap(await ctx.flowRunner.start(startInput()))
    if (opened.step.kind !== "open-external") throw new Error("no redirect")
    const flowKey = [...ctx.flowRunner.activeInstanceKeys()][0] ?? ""
    const pid = await pidOf(portOf(opened.step.url))

    // Disabling is a `config.save`, not a refresh. Withdrawing consent must reach the process.
    const saved = await ctx.config.save(
      configWith({ extensionDir, enabled: false }),
    )
    expect(saved.ok).toBe(true)

    expect(ctx.providerHost.status(flowKey)).toBe("stopped")
    expect(await awaitProcessGone(pid)).toBe(true)

    // Named, not a raw transport error against a dead child.
    const after = unwrap(
      await ctx.flowRunner.advance({
        sessionId: opened.sessionId,
        result: { kind: "poll" },
      }),
    )
    expect(after.step.kind).toBe("error")
    if (after.step.kind !== "error") return
    expect(after.step.message).toContain("no longer available")
  }, 60_000)
})

describe("the oauth fixture's own refusals", () => {
  /**
   * The cases above prove Spectrum's client works against a plugin that CHECKS. These prove the
   * checks exist: a fixture that answered every request would make those cases green with the
   * host token, the request bodies, and the plugin's session id all removed.
   */
  const withFixture = async (
    body: (input: {
      readonly port: number
      readonly token: string
    }) => Promise<void>,
  ): Promise<void> => {
    const token = "fixture-token"
    const port = 40_000 + Math.floor(Math.random() * 20_000)
    const child = Bun.spawn(
      [process.execPath, FIXTURE, "--port", String(port)],
      {
        env: { ...process.env, SPECTRUM_TOKEN: token },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    try {
      const deadline = Date.now() + 10_000
      for (;;) {
        try {
          const probe = await fetch(`http://127.0.0.1:${port}/models`)
          if (probe.ok) break
        } catch {
          // not bound yet
        }
        if (Date.now() > deadline) throw new Error("fixture never became ready")
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await body({ port, token })
    } finally {
      child.kill()
      await child.exited
    }
  }

  const post = (
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  it("refuses a flow call that carries no host token", async () => {
    await withFixture(async ({ port }) => {
      const response = await post(port, "/spectrum/v1/flow/signin/start", {
        context: "create",
        config: {},
      })
      expect(response.status).toBe(401)
    })
  }, 30_000)

  it("refuses a flow call whose host token is not the one Spectrum minted", async () => {
    await withFixture(async ({ port }) => {
      const response = await post(
        port,
        "/spectrum/v1/flow/signin/start",
        { context: "create", config: {} },
        { "x-spectrum-host-token": "not-the-host-token" },
      )
      expect(response.status).toBe(401)
    })
  }, 30_000)

  it("refuses a start body that carries no context or config", async () => {
    await withFixture(async ({ port, token }) => {
      const response = await post(
        port,
        "/spectrum/v1/flow/signin/start",
        { nothing: true },
        { "x-spectrum-host-token": token },
      )
      expect(response.status).toBe(400)
    })
  }, 30_000)

  it("refuses a next body whose session id the plugin never minted", async () => {
    await withFixture(async ({ port, token }) => {
      const started = await post(
        port,
        "/spectrum/v1/flow/signin/start",
        { context: "create", config: {} },
        { "x-spectrum-host-token": token },
      )
      expect(started.status).toBe(200)
      const response = await post(
        port,
        "/spectrum/v1/flow/signin/next",
        { sessionId: "a-spectrum-side-session-id", result: { kind: "poll" } },
        { "x-spectrum-host-token": token },
      )
      expect(response.status).toBe(400)
    })
  }, 30_000)
})
