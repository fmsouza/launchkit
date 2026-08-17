import { describe, expect, it } from "bun:test"
import type {
  FlowResponse,
  FlowStep,
  FlowToast,
  PluginError,
} from "@spectrum/extensions"
import { FLOW_LIMITS } from "@spectrum/extensions"
import type { Logger } from "@spectrum/logger"
import { type Result, err, ok } from "@spectrum/utils"
import {
  createFlowRunner,
  flowContributionIdOf,
  flowInstanceKey,
} from "./flow-runner"
import type { EnsureRunningInput } from "./host"

const formStep: FlowStep = { kind: "form", title: "Sign in", fields: [] }
const doneStep: FlowStep = {
  kind: "done",
  config: { serverUrl: "http://127.0.0.1:9000" },
  secrets: { apiKey: "sk" },
}

const startInput = {
  providerId: "acme",
  flowId: "signin",
  context: "create" as const,
  config: {},
}

/**
 * One thing the fake plugin serves per call: either a step, or the failure a real
 * `FlowClient` produces. The client-level error matters — `createFlowClient` validates every
 * response itself, so an unparseable step reaches the runner as `invalid-manifest`, never as
 * a `FlowStep` the runner has to reject on its own.
 */
type ClientError = { readonly clientError: PluginError }
type Served = FlowStep | ClientError
const clientError = (error: PluginError): ClientError => ({
  clientError: error,
})
const isClientError = (served: Served): served is ClientError =>
  "clientError" in served

type Call = {
  readonly op: "start" | "next"
  readonly baseUrl: string
  readonly hostToken: string | undefined
  readonly flowId: string
  readonly body: unknown
}

type LogEntry = {
  readonly level: string
  readonly msg: string
  readonly fields?: Record<string, unknown>
}

/** Captures every call instead of writing anywhere, so a test can assert what did — and,
 * for the redaction test, what did NOT — reach the log. */
const captureLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = []
  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, msg, ...(fields === undefined ? {} : { fields }) })
    }
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => logger,
  }
  return { logger, entries }
}

/**
 * `steps` is served one per call. `nowStepMs` advances the fake clock by that much on every
 * call, which is how the timeout case is driven without a real 10-minute wait.
 */
const harness = (opts: {
  steps: readonly Served[]
  nowStepMs?: number
  ensureFails?: PluginError
  toast?: FlowToast
  logger?: Logger
  baseUrl?: string
  hostToken?: string
}) => {
  const started: EnsureRunningInput[] = []
  const stopped: string[] = []
  const calls: Call[] = []
  let index = 0
  let clock = 0
  let nonce = 0
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:9000"
  const hostToken = opts.hostToken ?? "tok"

  const serve = async (
    op: "start" | "next",
    calledBaseUrl: string,
    calledToken: string | undefined,
    flowId: string,
    body: unknown,
  ): Promise<Result<FlowResponse, PluginError>> => {
    calls.push({
      op,
      baseUrl: calledBaseUrl,
      hostToken: calledToken,
      flowId,
      body,
    })
    const served = opts.steps[index++]
    if (served === undefined)
      return err({ kind: "read-failed", detail: "no more steps" })
    if (isClientError(served)) return err(served.clientError)
    return ok({
      sessionId: "plugin-session",
      step: served,
      ...(opts.toast === undefined ? {} : { toast: opts.toast }),
    })
  }

  const runner = createFlowRunner({
    host: {
      ensureRunning: async (input) => {
        started.push(input)
        return opts.ensureFails === undefined
          ? ok({ baseUrl, pid: 1, hostToken })
          : err(opts.ensureFails)
      },
      status: () => "running",
      stop: async (key: string) => {
        stopped.push(key)
      },
      stopAllFor: async () => {},
      stopAll: async () => {},
      retainOnly: async () => {},
    },
    client: {
      start: (base, token, flowId, body) =>
        serve("start", base, token, flowId, body),
      next: (base, token, flowId, body) =>
        serve("next", base, token, flowId, body),
    },
    idGen: () => `n${nonce++}`,
    now: () => {
      clock += opts.nowStepMs ?? 0
      return clock
    },
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  })
  return { runner, started, stopped, calls }
}

describe("createFlowRunner", () => {
  it("starts a dedicated flow instance and returns the first step", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.step.kind).toBe("form")
    expect(started[0]?.instanceKey).toMatch(/^flow:acme:/)
  })

  it("starts the flow instance with no secrets when the context is create", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    // Secrets are supplied and must still be dropped: a provider being created owns none,
    // so anything the caller passes belongs to some other record.
    await runner.start({ ...startInput, secrets: { apiKey: "not-mine" } })
    expect(started[0]?.secrets).toEqual({})
  })

  it("passes the provider's secrets through when the context is provider", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    await runner.start({
      ...startInput,
      context: "provider",
      secrets: { apiKey: "existing" },
    })
    expect(started[0]?.secrets).toEqual({ apiKey: "existing" })
  })

  it("sends the context and the caller's config on the opening call", async () => {
    const { runner, calls } = harness({ steps: [formStep] })
    await runner.start({ ...startInput, config: { region: "eu" } })
    expect(calls[0]?.op).toBe("start")
    expect(calls[0]?.flowId).toBe("signin")
    expect(calls[0]?.body).toEqual({
      context: "create",
      config: { region: "eu" },
    })
  })

  it("carries the host token on every flow call", async () => {
    const { runner, calls } = harness({ steps: [formStep, formStep] })
    const r = await runner.start(startInput)
    if (r.ok)
      await runner.advance({
        sessionId: r.value.sessionId,
        result: { kind: "ack" },
      })
    expect(calls.map((c) => c.hostToken)).toEqual(["tok", "tok"])
  })

  it("sends the plugin's own session id back, not Spectrum's", async () => {
    const { runner, calls } = harness({ steps: [formStep, formStep] })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await runner.advance({
      sessionId: r.value.sessionId,
      result: { kind: "ack" },
    })
    expect(calls[1]?.body).toEqual({
      sessionId: "plugin-session",
      result: { kind: "ack" },
    })
    expect(r.value.sessionId).not.toBe("plugin-session")
  })

  it("reports the flow key as active while the flow is live", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    await runner.start(startInput)
    expect([...runner.activeInstanceKeys()]).toEqual([
      started[0]?.instanceKey ?? "",
    ])
  })

  it("reports the flow key as active while the opening call is still in flight", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    // Deliberately not awaited: the child exists from the moment `ensureRunning` is entered,
    // so a retention sweep landing before the first step arrives must still see the key.
    const pending = runner.start(startInput)
    expect([...runner.activeInstanceKeys()]).toEqual([
      started[0]?.instanceKey ?? "",
    ])
    await pending
  })

  it("clamps a too-small poll interval on an await step", async () => {
    const { runner } = harness({
      steps: [{ kind: "await", title: "Waiting", pollMs: 5 }],
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.step.kind === "await")
      expect(r.value.step.pollMs).toBe(FLOW_LIMITS.minPollMs)
  })

  it("clamps a too-large poll interval on an await step", async () => {
    const { runner } = harness({
      steps: [{ kind: "await", title: "Waiting", pollMs: 900_000 }],
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.step.kind === "await")
      expect(r.value.step.pollMs).toBe(FLOW_LIMITS.maxPollMs)
  })

  it("passes the plugin's toast through with the step", async () => {
    const { runner } = harness({
      steps: [formStep],
      toast: { tone: "warning", message: "check your email" },
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.toast).toEqual({
        tone: "warning",
        message: "check your email",
      })
  })

  it("stops the flow instance when a done step arrives", async () => {
    const { runner, started, stopped } = harness({ steps: [doneStep] })
    await runner.start(startInput)
    expect(stopped).toEqual([started[0]?.instanceKey ?? ""])
  })

  it("drops the flow key from the active set once the flow ends", async () => {
    const { runner } = harness({ steps: [doneStep] })
    await runner.start(startInput)
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("holds the completion payload for one take and no more", async () => {
    const { runner } = harness({ steps: [doneStep] })
    const r = await runner.start(startInput)
    const sessionId = r.ok ? r.value.sessionId : ""
    expect(runner.takeCompletion(sessionId)).toEqual({
      config: { serverUrl: "http://127.0.0.1:9000" },
      secrets: { apiKey: "sk" },
    })
    expect(runner.takeCompletion(sessionId)).toBeUndefined()
  })

  it("completes with empty maps when the done step carries neither config nor secrets", async () => {
    const { runner } = harness({
      steps: [{ kind: "done", message: "all set" }],
    })
    const r = await runner.start(startInput)
    const sessionId = r.ok ? r.value.sessionId : ""
    expect(runner.takeCompletion(sessionId)).toEqual({
      config: {},
      secrets: {},
    })
  })

  it("drops an untaken completion when the flow is cancelled", async () => {
    const { runner } = harness({ steps: [doneStep] })
    const r = await runner.start(startInput)
    const sessionId = r.ok ? r.value.sessionId : ""
    await runner.cancel(sessionId)
    expect(runner.takeCompletion(sessionId)).toBeUndefined()
  })

  it("stops the flow instance and forgets the session when cancelled", async () => {
    const { runner, stopped } = harness({ steps: [formStep, formStep] })
    const r = await runner.start(startInput)
    const sessionId = r.ok ? r.value.sessionId : ""
    await runner.cancel(sessionId)
    expect(stopped.length).toBe(1)
    const after = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("not-found")
  })

  it("fails the flow when the step cap is exceeded", async () => {
    const { runner } = harness({ steps: Array(120).fill(formStep) })
    let last = await runner.start(startInput)
    for (
      let i = 0;
      i < 60 && last.ok && last.value.step.kind === "form";
      i += 1
    )
      last = await runner.advance({
        sessionId: last.value.sessionId,
        result: { kind: "form", values: {} },
      })
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.error.kind).toBe("read-failed")
  })

  it("delivers exactly the capped number of steps before refusing", async () => {
    const { runner, calls } = harness({ steps: Array(120).fill(formStep) })
    let last = await runner.start(startInput)
    for (
      let i = 0;
      i < 60 && last.ok && last.value.step.kind === "form";
      i += 1
    )
      last = await runner.advance({
        sessionId: last.value.sessionId,
        result: { kind: "form", values: {} },
      })
    // The refusing call never reaches the plugin, so the call count IS the delivered count.
    expect(calls.length).toBe(FLOW_LIMITS.maxSteps)
  })

  it("stops the flow instance when the step cap is exceeded", async () => {
    const { runner, stopped } = harness({ steps: Array(120).fill(formStep) })
    let last = await runner.start(startInput)
    for (
      let i = 0;
      i < 60 && last.ok && last.value.step.kind === "form";
      i += 1
    )
      last = await runner.advance({
        sessionId: last.value.sessionId,
        result: { kind: "form", values: {} },
      })
    expect(stopped.length).toBe(1)
  })

  it("fails the flow when the total timeout is exceeded", async () => {
    // The fake clock advances on every read, and the runner reads it once in `start`
    // (`startedAt`) and once in `advance` (the elapsed check) — so 700 000 ms per read puts
    // 700 000 ms of elapsed time on the second read, past the 600 000 ms cap.
    const { runner } = harness({
      steps: [formStep, formStep],
      nowStepMs: 700_000,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({
      sessionId,
      result: { kind: "form", values: {} },
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("read-failed")
  })

  it("stops the flow instance when the total timeout is exceeded", async () => {
    const { runner, stopped } = harness({
      steps: [formStep, formStep],
      nowStepMs: 700_000,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "form", values: {} } })
    expect(stopped.length).toBe(1)
  })

  it("keeps the flow alive while the elapsed time is inside the cap", async () => {
    const { runner } = harness({
      steps: [formStep, formStep],
      nowStepMs: 100_000,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({
      sessionId,
      result: { kind: "form", values: {} },
    })
    expect(second.ok).toBe(true)
  })

  it("stops the flow instance when the extension returns an error step", async () => {
    const { runner, stopped } = harness({
      steps: [{ kind: "error", message: "auth denied" }],
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.step.kind).toBe("error")
    expect(stopped.length).toBe(1)
  })

  it("fails with not-found when advancing an unknown session", async () => {
    const { runner } = harness({ steps: [formStep] })
    const r = await runner.advance({
      sessionId: "nope",
      result: { kind: "ack" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-found")
  })

  it("fails when the flow instance cannot start", async () => {
    const { runner } = harness({
      steps: [formStep],
      ensureFails: { kind: "not-found", id: "acme" },
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-found")
  })

  it("registers no session when the flow instance never starts", async () => {
    const { runner } = harness({
      steps: [formStep],
      ensureFails: { kind: "not-found", id: "acme" },
    })
    await runner.start(startInput)
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("fails with invalid-manifest when the contribution declares no launch block", async () => {
    // Flows are supervised-only: a user-run provider has no child Spectrum can start, so
    // there is nothing to serve the flow.
    const { runner } = harness({
      steps: [formStep],
      ensureFails: {
        kind: "invalid-manifest",
        detail: 'provider contribution "acme" declares no launch block',
      },
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("registers no session when the contribution declares no launch block", async () => {
    const { runner } = harness({
      steps: [formStep],
      ensureFails: {
        kind: "invalid-manifest",
        detail: 'provider contribution "acme" declares no launch block',
      },
    })
    await runner.start(startInput)
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("fails with write-failed when the flow instance never becomes ready", async () => {
    const { runner } = harness({
      steps: [formStep],
      ensureFails: {
        kind: "write-failed",
        detail: 'plugin provider "acme" failed readiness',
      },
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("write-failed")
  })

  it("fails with invalid-manifest when the plugin returns an unparseable step", async () => {
    const { runner } = harness({
      steps: [
        clientError({ kind: "invalid-manifest", detail: "unknown step kind" }),
      ],
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("stops the flow instance when the plugin returns an unparseable step", async () => {
    const { runner, stopped } = harness({
      steps: [
        clientError({ kind: "invalid-manifest", detail: "unknown step kind" }),
      ],
    })
    await runner.start(startInput)
    expect(stopped.length).toBe(1)
  })

  it("fails with read-failed when the flow call cannot reach the plugin", async () => {
    const { runner } = harness({
      steps: [
        formStep,
        clientError({ kind: "read-failed", detail: "socket closed" }),
      ],
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({
      sessionId,
      result: { kind: "ack" },
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("read-failed")
  })

  it("stops the flow instance when a flow call fails in transport", async () => {
    const { runner, stopped } = harness({
      steps: [
        formStep,
        clientError({ kind: "read-failed", detail: "socket closed" }),
      ],
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(stopped.length).toBe(1)
  })

  it("forgets the session when a flow call fails in transport", async () => {
    const { runner } = harness({
      steps: [
        formStep,
        clientError({ kind: "read-failed", detail: "socket closed" }),
      ],
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    const again = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.kind).toBe("not-found")
  })
})

describe("createFlowRunner abandon", () => {
  it("ends an abandoned flow with an error step naming the cause", async () => {
    const { runner, started } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.step.kind).toBe("error")
    if (second.value.step.kind === "error")
      expect(second.value.step.message).toContain("no longer enabled")
  })

  it("drops an abandoned flow's key from the active set", async () => {
    const { runner, started } = harness({ steps: [formStep, formStep] })
    await runner.start(startInput)
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("never reaches the plugin again once a flow is abandoned", async () => {
    const { runner, started, calls } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(calls.length).toBe(1)
  })

  it("forgets an abandoned session once its error step has been delivered", async () => {
    const { runner, started } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    await runner.advance({ sessionId, result: { kind: "ack" } })
    const again = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.kind).toBe("not-found")
  })

  it("leaves a flow alone when its key is not among the abandoned keys", async () => {
    const { runner } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    runner.abandon(["flow:other:n9"], "extension-disabled")
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value.step.kind).toBe("form")
  })
})

describe("flowInstanceKey / flowContributionIdOf", () => {
  it("round-trips the contribution id through the instance key", () => {
    expect(flowContributionIdOf(flowInstanceKey("acme", "n0"))).toBe("acme")
  })

  it("reports the contribution id of the key the runner actually minted", async () => {
    const { runner, started } = harness({ steps: [formStep] })
    await runner.start(startInput)
    expect(flowContributionIdOf(started[0]?.instanceKey ?? "")).toBe("acme")
  })

  it("returns undefined for a provider instance key", () => {
    // Provider keys are JSON produced by `providerInstanceKey`, never `flow:`-prefixed.
    expect(
      flowContributionIdOf('{"s":"plugin:acme","c":{},"r":{}}'),
    ).toBeUndefined()
  })

  it("returns undefined for a flow-prefixed key with no nonce", () => {
    expect(flowContributionIdOf("flow:acme")).toBeUndefined()
  })

  it("returns undefined for a flow-prefixed key with an empty contribution id", () => {
    expect(flowContributionIdOf("flow::n0")).toBeUndefined()
  })
})

describe("createFlowRunner logging", () => {
  it("logs the flow lifecycle without any of the values it must never record", async () => {
    const { logger, entries } = captureLogger()
    const { runner } = harness({
      steps: [
        formStep,
        {
          kind: "done",
          config: { serverUrl: "sentinel-done-config" },
          secrets: { apiKey: "sentinel-done-secret" },
        },
      ],
      logger,
      baseUrl: "http://127.0.0.1:59991",
      hostToken: "sentinel-host-token",
    })
    const first = await runner.start({
      ...startInput,
      context: "provider",
      config: { serverUrl: "sentinel-config-value" },
      secrets: { apiKey: "sentinel-secret-value" },
    })
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({
      sessionId,
      result: { kind: "form", values: { token: "sentinel-field-value" } },
    })

    const joined = JSON.stringify(entries)
    // Non-vacuous: the runner must actually have logged the lifecycle for the absence
    // assertions below to mean anything.
    expect(
      entries.some((e) => e.fields?.outcome === "done" && e.level === "info"),
    ).toBe(true)
    expect(entries.some((e) => e.fields?.kind === "form")).toBe(true)
    // The six prohibitions, in order: field values, config, secrets, the host token, the
    // base URL's port, and the instance key.
    expect(joined).not.toContain("sentinel-field-value")
    expect(joined).not.toContain("sentinel-config-value")
    expect(joined).not.toContain("sentinel-done-config")
    expect(joined).not.toContain("sentinel-secret-value")
    expect(joined).not.toContain("sentinel-done-secret")
    expect(joined).not.toContain("sentinel-host-token")
    expect(joined).not.toContain("59991")
    expect(joined).not.toContain("flow:acme:n0")
  })

  it("logs the outcome when a flow ends in an error step", async () => {
    const { logger, entries } = captureLogger()
    const { runner } = harness({
      steps: [{ kind: "error", message: "auth denied" }],
      logger,
    })
    await runner.start(startInput)
    expect(entries.some((e) => e.fields?.outcome === "error")).toBe(true)
  })
})
