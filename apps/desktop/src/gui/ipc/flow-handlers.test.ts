import { describe, expect, it } from "bun:test"
import type { Config } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import type { FlowStep, FlowToast, PluginError } from "@spectrum/extensions"
import type { Logger } from "@spectrum/logger"
import type {
  FlowAdvanceInput,
  FlowCompletion,
  FlowRunner,
  FlowStartInput,
  RunnerStep,
} from "@spectrum/provider-host"
import { createProviderRegistry, getDescriptor } from "@spectrum/providers"
import type { ProviderDescriptor } from "@spectrum/providers"
import type { Provider, ProviderId, SecretRef } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { GuiContext } from "../../composition"
import { createIpcHandlers } from "./handlers"

/**
 * The flow IPC surface, tested at the HANDLER — which is where the security decisions live:
 * sanitizing the `done` step, writing `done.secrets` to the keychain instead of the config
 * file, applying the add-provider validation to a flow-produced record, opening a url only
 * through the guarded capability, and mapping a `PluginError` to copy a user can act on.
 * A schema test alone would pin none of them.
 */

const PLUGIN_KEY = "plugin:acme"
const SECRET_VALUE = "sk-secret-value"

/** Two DECLARED secret fields, so "declared but empty" and "never declared" stay distinct. */
const acmeDescriptor: ProviderDescriptor = {
  ...getDescriptor("custom"),
  key: PLUGIN_KEY as ProviderDescriptor["key"],
  label: "Acme",
  secretFields: [
    { name: "apiKey", label: "API key", required: false },
    { name: "refreshToken", label: "Refresh token", required: false },
  ],
}

const startParams = {
  providerKey: PLUGIN_KEY,
  flowId: "signin",
  context: "create" as const,
  config: {},
}

const formStep: FlowStep = {
  kind: "form",
  title: "Sign in",
  fields: [{ name: "token", label: "Token", kind: "password", required: true }],
}

/** What a plugin's `done` step actually looks like — the runner passes it through verbatim. */
const doneStepWithSecret: FlowStep = {
  kind: "done",
  message: "Signed in",
  config: { serverUrl: "http://127.0.0.1:9000" },
  secrets: { apiKey: SECRET_VALUE },
}

const existingAcmeProvider: Provider = {
  id: "prv_1" as ProviderId,
  name: "Acme",
  sdkProvider: PLUGIN_KEY,
  config: { serverUrl: "http://127.0.0.1:1" },
  secrets: { apiKey: { ref: "kc_old" } },
  models: ["acme-1"],
}

type Harness = {
  /** Exposed so a test can build a SECOND handler set over the same runner. */
  readonly ctx: GuiContext
  readonly handlers: ReturnType<typeof createIpcHandlers>
  readonly saves: Config[]
  readonly secretSets: string[]
  readonly opened: string[]
  readonly cancelled: string[]
  readonly starts: FlowStartInput[]
  readonly advances: FlowAdvanceInput[]
  readonly takes: string[]
  readonly logLines: string[]
}

const harness = (
  opts: {
    /** Delivered in order: the first by `start`, each next one by `advance`. */
    steps?: readonly FlowStep[]
    toast?: FlowToast
    startFails?: PluginError
    advanceFails?: PluginError
    providers?: readonly Provider[]
    /** Simulates the second concurrent `advance` the runner refuses. */
    advanceInFlight?: boolean
    openExternalOk?: boolean
    secretSetFails?: boolean
    saveFails?: boolean
    /** Simulates a `done` whose payload was already drained (a replay / double delivery). */
    dropCompletion?: boolean
    secretGet?: Record<string, string>
    /** Registered plugin descriptors; defaults to the acme fixture. */
    plugins?: readonly ProviderDescriptor[]
  } = {},
): Harness => {
  const saves: Config[] = []
  const secretSets: string[] = []
  const opened: string[] = []
  const cancelled: string[] = []
  const starts: FlowStartInput[] = []
  const advances: FlowAdvanceInput[] = []
  const takes: string[] = []
  const logLines: string[] = []

  let config: Config = {
    ...defaultConfig(),
    providers: [...(opts.providers ?? [])],
  }

  let delivered = 0
  const completions = new Map<string, FlowCompletion>()
  /** Sessions the fake runner still knows about — every terminal path forgets one. */
  const live = new Set<string>()

  const deliver = (sessionId: string): Result<RunnerStep, PluginError> => {
    const step = opts.steps?.[delivered]
    delivered += 1
    if (step === undefined) return err({ kind: "not-found", id: sessionId })
    // Mirrors the real runner: the completion is stashed for exactly one `takeCompletion`,
    // and the STEP still carries whatever the plugin sent. Sanitizing it is the handler's job.
    if (step.kind === "done")
      completions.set(sessionId, {
        config: { ...(step.config ?? {}) },
        secrets: { ...(step.secrets ?? {}) },
      })
    if (step.kind === "done" || step.kind === "error") live.delete(sessionId)
    return ok({
      sessionId,
      step,
      ...(opts.toast === undefined ? {} : { toast: opts.toast }),
    })
  }

  const flowRunner: FlowRunner = {
    start: async (input) => {
      starts.push(input)
      if (opts.startFails !== undefined) return err(opts.startFails)
      live.add("fs_1")
      return deliver("fs_1")
    },
    advance: async (input) => {
      advances.push(input)
      if (opts.advanceInFlight === true)
        return err({
          kind: "read-failed",
          detail: "a flow step is already in flight",
        })
      // An unknown, ended, or cancelled session is `not-found` in the real runner too.
      if (!live.has(input.sessionId))
        return err({ kind: "not-found", id: input.sessionId })
      if (opts.advanceFails !== undefined) return err(opts.advanceFails)
      return deliver(input.sessionId)
    },
    takeCompletion: (sessionId) => {
      takes.push(sessionId)
      if (opts.dropCompletion === true) return undefined
      const completion = completions.get(sessionId)
      completions.delete(sessionId)
      return completion
    },
    cancel: async (sessionId) => {
      cancelled.push(sessionId)
      // A cancelled flow's untaken completion is dropped, exactly as the real runner does.
      live.delete(sessionId)
      completions.delete(sessionId)
    },
    activeInstanceKeys: () => new Set<string>(),
    abandon: () => {},
  }

  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      logLines.push(
        `${level} ${msg} ${fields === undefined ? "" : JSON.stringify(fields)}`,
      )
    }
  const log: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => log,
  }

  const ctx = {
    log,
    config: {
      load: async (): Promise<Result<Config, never>> => ok(config),
      save: async (next: Config) => {
        if (opts.saveFails === true)
          return err({ kind: "write-failed", detail: "read-only volume" })
        saves.push(next)
        config = next
        return ok(undefined)
      },
    },
    secrets: {
      set: async (value: string) => {
        secretSets.push(value)
        return opts.secretSetFails === true
          ? err({ kind: "backend-failed", detail: "locked" })
          : ok({ ref: `kc_${secretSets.length}` })
      },
      get: async (ref: SecretRef) => {
        const found = opts.secretGet?.[ref.ref]
        return found === undefined ? err({ kind: "not-found" }) : ok(found)
      },
      delete: async () => ok(undefined),
      has: async () => true,
    },
    providerRegistry: createProviderRegistry(opts.plugins ?? [acmeDescriptor]),
    flowRunner,
    openExternalGuarded: async (url: string) => {
      opened.push(url)
      return opts.openExternalOk === false
        ? err({
            kind: "write-failed",
            detail: "the OS refused to open the url",
          })
        : ok(undefined)
    },
  } as unknown as GuiContext

  return {
    ctx,
    handlers: createIpcHandlers(ctx),
    saves,
    secretSets,
    opened,
    cancelled,
    starts,
    advances,
    takes,
    logLines,
  }
}

const savedProviders = (h: Harness): readonly Provider[] =>
  h.saves.at(-1)?.providers ?? []

/**
 * The session id of a STARTED flow. `sessionId` is optional on the result because a start
 * refused before the runner was ever asked creates no session, so reading it here also
 * asserts that this start actually produced one.
 */
const sessionOf = (r: {
  readonly sessionId?: string | undefined
}): string => {
  expect(r.sessionId).toBeDefined()
  return r.sessionId ?? "no-session-was-created"
}

describe("createIpcHandlers.startProviderFlow", () => {
  it("returns the plugin's first step to the renderer unchanged", async () => {
    const { handlers } = harness({ steps: [formStep] })
    const started = await handlers.startProviderFlow(startParams)
    expect(started.step).toEqual(formStep)
    expect(sessionOf(started)).toBe("fs_1")
  })

  it("passes the plugin contribution id to the runner, not the plugin: key", async () => {
    const { handlers, starts } = harness({ steps: [formStep] })
    await handlers.startProviderFlow(startParams)
    expect(starts[0]?.providerId).toBe("acme")
  })

  it("carries the plugin's toast alongside the step", async () => {
    const { handlers } = harness({
      steps: [formStep],
      toast: { tone: "warning", message: "slow" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(started.toast).toEqual({ tone: "warning", message: "slow" })
  })

  it("persists flow secrets to the secret store and never returns them", async () => {
    const h = harness({ steps: [doneStepWithSecret] })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(JSON.stringify(started)).not.toContain(SECRET_VALUE)
    expect(h.secretSets).toEqual([SECRET_VALUE])
  })

  it("sanitizes the done step down to its message before responding", async () => {
    const { handlers } = harness({ steps: [doneStepWithSecret] })
    const started = await handlers.startProviderFlow(startParams)
    expect(started.step).toEqual({ kind: "done", message: "Signed in" })
  })

  it("creates a saved provider from the flow output when the context is create", async () => {
    const h = harness({ steps: [doneStepWithSecret] })
    await h.handlers.startProviderFlow(startParams)
    const providers = savedProviders(h)
    expect(providers).toHaveLength(1)
    expect(providers[0]?.sdkProvider).toBe(PLUGIN_KEY)
    expect(providers[0]?.config).toEqual({
      serverUrl: "http://127.0.0.1:9000",
    })
    // The keychain REF is stored, never the value.
    expect(JSON.stringify(providers[0]?.secrets)).not.toContain(SECRET_VALUE)
    expect(providers[0]?.secrets).toEqual({ apiKey: { ref: "kc_1" } })
  })

  it("keeps the config the flow was started with alongside what the flow returned", async () => {
    const h = harness({
      steps: [{ kind: "done", config: { serverUrl: "http://127.0.0.1:9000" } }],
    })
    await h.handlers.startProviderFlow({
      ...startParams,
      config: { headers: '{"X-A":"1"}' },
    })
    expect(savedProviders(h)[0]?.config).toEqual({
      headers: '{"X-A":"1"}',
      serverUrl: "http://127.0.0.1:9000",
    })
  })

  it("mints a provider id and names the record after the provider's label", async () => {
    // These params carry no `name`, so the descriptor's label is the record's only chance at
    // being called "Acme" instead of "plugin:acme".
    const h = harness({ steps: [doneStepWithSecret] })
    await h.handlers.startProviderFlow(startParams)
    expect(savedProviders(h)[0]?.id).toMatch(/^p_/)
    expect(savedProviders(h)[0]?.name).toBe("Acme")
  })

  it("reports a failure rather than success when the done step carries no completion", async () => {
    // The runner stashes a completion on every `done`, so this is a replayed or twice-delivered
    // step. Telling the user "Signed in" while nothing was saved is the failure being pinned.
    const h = harness({ steps: [doneStepWithSecret], dropCompletion: true })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.saves).toEqual([])
    expect(h.secretSets).toEqual([])
  })

  it("drops a secret the provider never declared", async () => {
    const h = harness({
      steps: [
        {
          kind: "done",
          secrets: { apiKey: SECRET_VALUE, sessionCookie: "sc-1" },
        },
      ],
    })
    await h.handlers.startProviderFlow(startParams)
    expect(h.secretSets).toEqual([SECRET_VALUE])
    expect(Object.keys(savedProviders(h)[0]?.secrets ?? {})).toEqual(["apiKey"])
  })

  it("cannot be driven past one keychain write per declared secret field", async () => {
    // Without the declared-field filter the write loop is bounded only by the flow response
    // size cap, so a buggy or hostile extension can drive thousands of keychain round trips.
    const flood = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field_${i}`, `v-${i}`]),
    )
    const h = harness({
      steps: [
        {
          kind: "done",
          secrets: { ...flood, apiKey: SECRET_VALUE, refreshToken: "rt-1" },
        },
      ],
    })
    await h.handlers.startProviderFlow(startParams)
    expect(h.secretSets).toHaveLength(acmeDescriptor.secretFields.length)
    expect(h.secretSets.sort()).toEqual([SECRET_VALUE, "rt-1"].sort())
  })

  it("refuses to save a flow-produced record the add-provider handler would reject", async () => {
    // `plugin:acme`'s config schema is `.strict()`, so an undeclared key is exactly what
    // `validateProviderConfig` refuses on the `addProvider` path.
    const h = harness({
      steps: [{ kind: "done", config: { apiVersion: "9" } }],
    })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.saves).toEqual([])
  })

  it("writes no secret to the keychain when the record it would produce is invalid", async () => {
    const h = harness({
      steps: [
        {
          kind: "done",
          config: { apiVersion: "9" },
          secrets: { apiKey: SECRET_VALUE },
        },
      ],
    })
    await h.handlers.startProviderFlow(startParams)
    expect(h.secretSets).toEqual([])
  })

  it("writes no keychain entry for a secret the flow returned empty", async () => {
    // An empty value stored under a field name would make the provider LOOK configured while
    // authenticating with nothing. Same rule `addProvider` applies to its inline secrets.
    const h = harness({
      steps: [{ kind: "done", secrets: { apiKey: "", refreshToken: "rt-1" } }],
    })
    await h.handlers.startProviderFlow(startParams)
    expect(h.secretSets).toEqual(["rt-1"])
    expect(Object.keys(savedProviders(h)[0]?.secrets ?? {})).toEqual([
      "refreshToken",
    ])
  })

  it("returns an error step rather than saving when the keychain write fails", async () => {
    const h = harness({ steps: [doneStepWithSecret], secretSetFails: true })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.saves).toEqual([])
  })

  it("tells the user setup did not stick when the config write fails", async () => {
    const h = harness({ steps: [doneStepWithSecret], saveFails: true })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({ kind: "error" })
  })

  it("updates the named provider instead of creating one when the context is provider", async () => {
    const h = harness({
      steps: [doneStepWithSecret],
      providers: [existingAcmeProvider],
    })
    await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_1" as ProviderId,
    })
    const providers = savedProviders(h)
    expect(providers).toHaveLength(1)
    expect(String(providers[0]?.id)).toBe("prv_1")
    expect(providers[0]?.name).toBe("Acme")
    expect(providers[0]?.models).toEqual(["acme-1"])
    expect(providers[0]?.config).toEqual({
      serverUrl: "http://127.0.0.1:9000",
    })
    expect(providers[0]?.secrets).toEqual({ apiKey: { ref: "kc_1" } })
  })

  it("hands the named provider's resolved secrets to the runner when the context is provider", async () => {
    const h = harness({
      steps: [formStep],
      providers: [existingAcmeProvider],
      secretGet: { kc_old: "sk-existing" },
    })
    await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_1" as ProviderId,
    })
    expect(h.starts[0]?.secrets).toEqual({ apiKey: "sk-existing" })
  })

  it("starts the flow anyway when a stored credential has vanished from the keychain", async () => {
    // A credential that is gone is precisely what a re-auth flow exists to replace, so a
    // failed keychain read must neither block the flow nor put a non-value in the child's env.
    const h = harness({
      steps: [formStep],
      providers: [existingAcmeProvider],
      secretGet: {},
    })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_1" as ProviderId,
    })
    expect(started.step).toMatchObject({ kind: "form" })
    // Keys, not `toEqual({})`: an `{ apiKey: undefined }` compares equal to `{}` under
    // `toEqual`, which would let a non-value into the child's environment unnoticed.
    expect(Object.keys(h.starts[0]?.secrets ?? {})).toEqual([])
  })

  it("sends no secrets to the runner when the context is create", async () => {
    const h = harness({ steps: [formStep], providers: [existingAcmeProvider] })
    await h.handlers.startProviderFlow(startParams)
    expect(h.starts[0]?.secrets).toBeUndefined()
  })

  it("returns an error step when a provider-context start names no provider", async () => {
    const h = harness({ steps: [formStep] })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
    })
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.starts).toEqual([])
  })

  it("returns an error step when a provider-context start names an unknown provider", async () => {
    const h = harness({ steps: [formStep] })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_missing" as ProviderId,
    })
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.starts).toEqual([])
  })

  it("refuses to hand one provider's secrets to a different provider's flow", async () => {
    // A mismatched key/id pair: the record is an OpenAI provider, the flow is acme's.
    const h = harness({
      steps: [formStep],
      providers: [
        {
          ...existingAcmeProvider,
          sdkProvider: "openai",
          secrets: { apiKey: { ref: "kc_openai" } },
        },
      ],
      secretGet: { kc_openai: "sk-openai-secret" },
    })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_1" as ProviderId,
    })
    expect(started.step).toMatchObject({ kind: "error" })
    expect(h.starts).toEqual([])
    expect(JSON.stringify(h.starts)).not.toContain("sk-openai-secret")
  })

  it("refuses to write into a record that was repointed at another provider mid-flow", async () => {
    const h = harness({
      steps: [formStep, doneStepWithSecret],
      providers: [existingAcmeProvider],
      secretGet: { kc_old: "sk-existing" },
    })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      context: "provider",
      providerId: "prv_1" as ProviderId,
    })
    // What `updateProvider` does when the user edits that record in another part of the UI.
    const loaded = await h.ctx.config.load()
    if (loaded.ok)
      await h.ctx.config.save({
        ...loaded.value,
        providers: [{ ...existingAcmeProvider, sdkProvider: "openai" }],
      })
    const before = h.saves.length

    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "ack" },
    })
    expect(next.step).toMatchObject({ kind: "error" })
    expect(h.saves).toHaveLength(before)
    expect(h.secretSets).toEqual([])
  })

  it("opens the external url through the guarded capability when the step is open-external", async () => {
    const h = harness({
      steps: [{ kind: "open-external", title: "Go", url: "https://e.com/a" }],
    })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(h.opened).toEqual(["https://e.com/a"])
    expect(started.step).toMatchObject({ kind: "open-external" })
  })

  it("replaces the step with an error when the guarded opener refuses", async () => {
    const h = harness({
      steps: [{ kind: "open-external", title: "Go", url: "https://e.com/a" }],
      openExternalOk: false,
    })
    const started = await h.handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({
      kind: "error",
      message: expect.stringContaining("browser"),
    })
  })

  it("opens nothing when the step is not an open-external step", async () => {
    const h = harness({ steps: [formStep] })
    await h.handlers.startProviderFlow(startParams)
    expect(h.opened).toEqual([])
  })

  it("refuses to start a flow for a provider key that is not a plugin key", async () => {
    const h = harness({ steps: [formStep] })
    const started = await h.handlers.startProviderFlow({
      ...startParams,
      providerKey: "openai",
    })
    expect(started.step).toMatchObject({
      kind: "error",
      message: expect.stringContaining("does not offer that setup flow"),
    })
    expect(h.starts).toEqual([])
  })

  it("reads a runner invalid-manifest failure as needing a newer Spectrum", async () => {
    const { handlers } = harness({
      startFails: { kind: "invalid-manifest", detail: "no launch" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(started).toMatchObject({
      step: {
        kind: "error",
        message: expect.stringContaining("this step needs a newer Spectrum"),
      },
    })
  })

  it("names the extension in the message when the failure knows which one it was", async () => {
    const { handlers } = harness({
      startFails: { kind: "invalid-manifest", detail: "no launch", id: "acme" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(started.step).toMatchObject({
      kind: "error",
      message: expect.stringContaining("acme"),
    })
  })

  it("reads a runner not-found failure as the flow not being offered", async () => {
    const { handlers } = harness({
      startFails: { kind: "not-found", id: "acme" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(started).toMatchObject({
      step: {
        kind: "error",
        message: expect.stringContaining(
          "this extension does not offer that setup flow",
        ),
      },
    })
  })

  it("reads a runner read-failed failure as the extension having stopped responding", async () => {
    const { handlers } = harness({
      startFails: { kind: "read-failed", detail: "ECONNREFUSED" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(started).toMatchObject({
      step: {
        kind: "error",
        message: expect.stringContaining("the extension stopped responding"),
      },
    })
  })

  it("keeps the extension's own error detail out of the message shown to the user", async () => {
    const { handlers } = harness({
      startFails: { kind: "read-failed", detail: "<script>alert(1)</script>" },
    })
    const started = await handlers.startProviderFlow(startParams)
    expect(JSON.stringify(started)).not.toContain("script")
  })
})

describe("createIpcHandlers.advanceProviderFlow", () => {
  it("relays the next step when the plugin answers", async () => {
    const { handlers } = harness({
      steps: [
        formStep,
        { kind: "message", title: "Hi", body: "b", tone: "info" },
      ],
    })
    const started = await handlers.startProviderFlow(startParams)
    const next = await handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "form", values: { token: SECRET_VALUE } },
    })
    expect(next.step).toMatchObject({ kind: "message", title: "Hi" })
  })

  it("saves the provider when the done step arrives on an advance rather than the start", async () => {
    const h = harness({ steps: [formStep, doneStepWithSecret] })
    const started = await h.handlers.startProviderFlow(startParams)
    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "form", values: { token: SECRET_VALUE } },
    })
    expect(next.step).toEqual({ kind: "done", message: "Signed in" })
    expect(h.secretSets).toEqual([SECRET_VALUE])
    expect(savedProviders(h)[0]?.sdkProvider).toBe(PLUGIN_KEY)
  })

  it("opens the external url on an advance too", async () => {
    const h = harness({
      steps: [
        formStep,
        { kind: "open-external", title: "Go", url: "https://e.com/b" },
      ],
    })
    const started = await h.handlers.startProviderFlow(startParams)
    await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "ack" },
    })
    expect(h.opened).toEqual(["https://e.com/b"])
  })

  it("returns no step at all when a step is already in flight for that session", async () => {
    const h = harness({ steps: [formStep], advanceInFlight: true })
    const started = await h.handlers.startProviderFlow(startParams)
    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "poll" },
    })
    expect(next).toEqual({ sessionId: sessionOf(started) })
  })

  it("reads a genuine read-failed on an advance as the extension having stopped responding", async () => {
    const h = harness({
      steps: [formStep],
      advanceFails: { kind: "read-failed", detail: "socket hang up" },
    })
    const started = await h.handlers.startProviderFlow(startParams)
    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "poll" },
    })
    expect(next.step).toMatchObject({
      kind: "error",
      message: expect.stringContaining("the extension stopped responding"),
    })
  })

  // `flowRunner` is shared on the AppContext while these origins are per-handler-set, so a
  // handler set that did not START a session must not be able to finish one — persisting a
  // completion against an origin it never recorded is exactly the wrong thing to guess at.
  it("persists nothing for a live session another handler set started", async () => {
    const h = harness({ steps: [formStep, doneStepWithSecret] })
    const started = await h.handlers.startProviderFlow(startParams)
    const other = createIpcHandlers(h.ctx)
    const next = await other.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "ack" },
    })
    expect(next.step).toMatchObject({ kind: "error" })
    expect(h.saves).toEqual([])
    expect(h.secretSets).toEqual([])
    expect(h.advances).toEqual([])
  })

  it("returns an error step for a session it never started", async () => {
    const { handlers } = harness({ steps: [formStep] })
    const next = await handlers.advanceProviderFlow({
      sessionId: "fs_unknown",
      result: { kind: "poll" },
    })
    expect(next.step).toMatchObject({ kind: "error" })
  })

  it("reads a not-found on a step as the setup session having ended, not the flow being unoffered", async () => {
    // The SAME error kind means two different things depending on which call produced it:
    // on `start` the contribution offers no such flow, on a step the session is simply over.
    // Telling a user mid-setup that "this extension does not offer that setup flow" sends
    // them looking for a broken extension when their session merely ended.
    const h = harness({
      steps: [formStep],
      advanceFails: { kind: "not-found", id: "fs_session" },
    })
    const started = await h.handlers.startProviderFlow(startParams)
    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "poll" },
    })
    expect(next.step).toMatchObject({
      kind: "error",
      message: expect.stringContaining("setup session has ended"),
    })
  })

  it("never renders a session handle into the message of a step that failed", async () => {
    // `not-found` used to interpolate `error.id`, which on this path is the Spectrum-side
    // flow session handle — meaningless to a user and not something product copy should carry.
    const h = harness({
      steps: [formStep],
      advanceFails: { kind: "not-found", id: "fs_the_session_handle" },
    })
    const started = await h.handlers.startProviderFlow(startParams)
    const next = await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "poll" },
    })
    const step = next.step
    expect(step?.kind).toBe("error")
    if (step?.kind !== "error") return
    expect(step.message).not.toContain("fs_the_session_handle")
  })

  it("never logs a flow field value", async () => {
    const h = harness({ steps: [formStep, doneStepWithSecret] })
    const started = await h.handlers.startProviderFlow(startParams)
    await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "form", values: { token: SECRET_VALUE } },
    })
    expect(h.logLines.join("\n")).not.toContain(SECRET_VALUE)
    expect(h.logLines.join("\n")).not.toContain("127.0.0.1:9000")
  })
})

describe("createIpcHandlers.cancelProviderFlow", () => {
  it("cancels the flow when the renderer cancels", async () => {
    const h = harness({ steps: [formStep] })
    const started = await h.handlers.startProviderFlow(startParams)
    const r = await h.handlers.cancelProviderFlow({
      sessionId: sessionOf(started),
    })
    expect(h.cancelled).toEqual([sessionOf(started)])
    expect(r).toBeNull()
  })

  // Symmetric with the advance guard above: ending someone else's flow is as wrong as
  // finishing it, and `flowRunner` is shared on the AppContext.
  it("does not cancel a session another handler set started", async () => {
    const h = harness({ steps: [formStep] })
    const started = await h.handlers.startProviderFlow(startParams)
    const other = createIpcHandlers(h.ctx)
    await other.cancelProviderFlow({ sessionId: sessionOf(started) })
    expect(h.cancelled).toEqual([])
  })

  it("saves nothing when a cancelled flow is later advanced", async () => {
    const h = harness({ steps: [formStep, doneStepWithSecret] })
    const started = await h.handlers.startProviderFlow(startParams)
    await h.handlers.cancelProviderFlow({ sessionId: sessionOf(started) })
    await h.handlers.advanceProviderFlow({
      sessionId: sessionOf(started),
      result: { kind: "ack" },
    })
    expect(h.saves).toEqual([])
    expect(h.secretSets).toEqual([])
  })
})
