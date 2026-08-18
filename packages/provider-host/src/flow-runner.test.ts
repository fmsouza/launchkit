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
import { NO_LAUNCH_BLOCK_DETAIL } from "./host"
import type { EnsureRunningInput, PluginStatus } from "./host"

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
  readonly timeoutMs: number
}

type LogEntry = {
  readonly level: string
  readonly msg: string
  readonly fields?: Record<string, unknown>
}

/** A promise a test releases by hand, to hold a call open across an await. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve()
    }
  })
  return { promise, release }
}

/** Lets every pending microtask AND the suspended calls above them settle. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

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

type FakeTimer = { readonly ms: number; readonly fire: () => void }

/**
 * `steps` is served one per call. `nowStepMs` advances the fake clock by that much on every
 * call, which is how the elapsed-budget case is driven without a real 10-minute wait; the
 * deadline itself is driven by `fireTimers`.
 */
const harness = (opts: {
  steps: readonly Served[]
  nowStepMs?: number
  ensureFails?: PluginError
  /** Address the host reports from the SECOND `ensureRunning` on — i.e. after a restart. */
  addressAfterStart?: {
    baseUrl?: string
    pid?: number
    hostToken?: string
  }
  hostStatus?: () => PluginStatus
  /** Holds `ensureRunning` open so a test can act while the child is still spawning. */
  ensureGate?: Promise<void>
  /** 1-based index of the first `ensureRunning` `ensureGate` applies to. */
  ensureGateFrom?: number
  /** Holds plugin calls open so a test can act while a step is in flight. */
  callGate?: Promise<void>
  /** 1-based index of the first call `callGate` applies to. Defaults to the opening call. */
  gateFrom?: number
  toast?: FlowToast
  logger?: Logger
  baseUrl?: string
  hostToken?: string
}) => {
  const started: EnsureRunningInput[] = []
  const stopped: string[] = []
  const calls: Call[] = []
  const timers: FakeTimer[] = []
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
    timeoutMs: number,
  ): Promise<Result<FlowResponse, PluginError>> => {
    calls.push({
      op,
      baseUrl: calledBaseUrl,
      hostToken: calledToken,
      flowId,
      body,
      timeoutMs,
    })
    if (opts.callGate !== undefined && calls.length >= (opts.gateFrom ?? 1))
      await opts.callGate
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
        if (
          opts.ensureGate !== undefined &&
          started.length >= (opts.ensureGateFrom ?? 1)
        )
          await opts.ensureGate
        if (opts.ensureFails !== undefined) return err(opts.ensureFails)
        const after = started.length > 1 ? opts.addressAfterStart : undefined
        return ok({
          baseUrl: after?.baseUrl ?? baseUrl,
          pid: after?.pid ?? 1,
          hostToken: after?.hostToken ?? hostToken,
        })
      },
      status: () => opts.hostStatus?.() ?? "running",
      stop: async (key: string) => {
        stopped.push(key)
      },
      stopAllFor: async () => {},
      stopAll: async () => {},
      retainOnly: async () => {},
    },
    client: {
      start: (base, token, flowId, body, timeoutMs) =>
        serve("start", base, token, flowId, body, timeoutMs),
      next: (base, token, flowId, body, timeoutMs) =>
        serve("next", base, token, flowId, body, timeoutMs),
    },
    idGen: () => `n${nonce++}`,
    now: () => {
      clock += opts.nowStepMs ?? 0
      return clock
    },
    setTimer: (ms, onFire) => {
      const timer: FakeTimer = { ms, fire: onFire }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as FakeTimer)
      if (at >= 0) timers.splice(at, 1)
    },
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  })

  /** Fire every armed deadline, as a one-shot timer does. */
  const fireTimers = (): void => {
    for (const timer of timers.splice(0, timers.length)) timer.fire()
  }

  return { runner, started, stopped, calls, timers, fireTimers }
}

describe("createFlowRunner", () => {
  it("clears every armed deadline when disposed", async () => {
    // A ten-minute one-shot timer per live flow keeps an event loop alive on its own. The
    // desktop app exits natively so it never notices, but `AppContext.shutdown` is the
    // documented teardown for any embedder, and nothing else can reach these handles.
    const { runner, timers } = harness({ steps: [formStep] })
    await runner.start(startInput)
    expect(timers).toHaveLength(1)
    runner.dispose()
    expect(timers).toHaveLength(0)
  })

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
    if (!r.ok) return
    expect(r.value.step.kind).toBe("await")
    if (r.value.step.kind === "await")
      expect(r.value.step.pollMs).toBe(FLOW_LIMITS.minPollMs)
  })

  it("clamps a too-large poll interval on an await step", async () => {
    const { runner } = harness({
      steps: [{ kind: "await", title: "Waiting", pollMs: 900_000 }],
    })
    const r = await runner.start(startInput)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.step.kind).toBe("await")
    if (r.value.step.kind === "await")
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
    // The detail distinguishes this from the timeout cap and from a transport failure, both
    // of which are also `read-failed`.
    if (!last.ok) {
      expect(last.error.kind).toBe("read-failed")
      if (last.error.kind === "read-failed")
        expect(last.error.detail).toContain("50 steps")
    }
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

  it("fails the flow when the elapsed budget is exceeded", async () => {
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
    if (!second.ok) {
      expect(second.error.kind).toBe("read-failed")
      if (second.error.kind === "read-failed")
        expect(second.error.detail).toContain("total timeout")
    }
  })

  it("stops the flow instance when the elapsed budget is exceeded", async () => {
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
        detail: NO_LAUNCH_BLOCK_DETAIL,
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
        detail: NO_LAUNCH_BLOCK_DETAIL,
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

describe("createFlowRunner address re-check", () => {
  it("re-obtains the child's address on every step", async () => {
    const { runner, started } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(started.length).toBe(2)
  })

  it("fails the flow when its child was restarted on a new port", async () => {
    const { runner } = harness({
      steps: [formStep, formStep],
      addressAfterStart: { baseUrl: "http://127.0.0.1:9001" },
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.kind).toBe("read-failed")
      if (second.error.kind === "read-failed")
        expect(second.error.detail).toContain("restarted")
    }
  })

  it("fails the flow when its child was restarted with a new host token", async () => {
    const { runner } = harness({
      steps: [formStep, formStep],
      addressAfterStart: { hostToken: "a-different-token" },
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("read-failed")
  })

  it("fails the flow when its child came back as a different process", async () => {
    const { runner } = harness({
      steps: [formStep, formStep],
      addressAfterStart: { pid: 4242 },
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("read-failed")
  })

  it("never sends the step to a restarted child", async () => {
    // The whole point: a form result carries the credentials the user just typed, and the
    // freed port may now belong to something else entirely.
    const { runner, calls } = harness({
      steps: [formStep, formStep],
      addressAfterStart: { baseUrl: "http://127.0.0.1:9001" },
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({
      sessionId,
      result: { kind: "form", values: { apiKey: "typed-by-the-user" } },
    })
    expect(calls.length).toBe(1)
  })

  it("stops the flow instance when its child was restarted", async () => {
    const { runner, stopped } = harness({
      steps: [formStep, formStep],
      addressAfterStart: { baseUrl: "http://127.0.0.1:9001" },
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(stopped.length).toBe(1)
  })

  it("fails the flow when its child is no longer running", async () => {
    const { runner } = harness({
      steps: [formStep, formStep],
      hostStatus: () => "stopped",
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.kind).toBe("read-failed")
      if (second.error.kind === "read-failed")
        expect(second.error.detail).toContain("no longer running")
    }
  })

  it("never respawns a flow instance that is no longer running", async () => {
    const { runner, started } = harness({
      steps: [formStep, formStep],
      hostStatus: () => "stopped",
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(started.length).toBe(1)
  })
})

describe("createFlowRunner concurrency", () => {
  it("refuses a second advance while one is already in flight", async () => {
    // An `await`-step poll firing while the user submits a form is the real shape of this.
    const gate = deferred()
    const { runner } = harness({
      steps: [formStep, formStep, formStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""

    const inFlight = runner.advance({ sessionId, result: { kind: "poll" } })
    const second = await runner.advance({
      sessionId,
      result: { kind: "form", values: {} },
    })
    gate.release()
    await inFlight

    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.kind).toBe("read-failed")
      if (second.error.kind === "read-failed")
        expect(second.error.detail).toContain("already in flight")
    }
  })

  it("never double-calls the plugin when two advances race", async () => {
    const gate = deferred()
    const { runner, calls } = harness({
      steps: [formStep, formStep, formStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""

    const inFlight = runner.advance({ sessionId, result: { kind: "poll" } })
    await runner.advance({ sessionId, result: { kind: "ack" } })
    gate.release()
    await inFlight
    // One opening call plus one advance — the refused advance reached nothing.
    expect(calls.length).toBe(2)
  })

  it("keeps accepting steps once an in-flight one has returned", async () => {
    const gate = deferred()
    const { runner } = harness({
      steps: [formStep, formStep, formStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""
    const inFlight = runner.advance({ sessionId, result: { kind: "poll" } })
    gate.release()
    await inFlight
    const after = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(after.ok).toBe(true)
  })

  it("delivers no step for a session cancelled while its step was in flight", async () => {
    const gate = deferred()
    const { runner, stopped } = harness({
      steps: [formStep, doneStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""

    const inFlight = runner.advance({ sessionId, result: { kind: "ack" } })
    // Let the advance get all the way to the (gated) plugin call before cancelling, so this
    // pins the window where the PLUGIN CALL is outstanding — not the earlier address check.
    await flush()
    await runner.cancel(sessionId)
    gate.release()
    const raced = await inFlight

    expect(raced.ok).toBe(false)
    if (!raced.ok) expect(raced.error.kind).toBe("not-found")
    // The `done` the plugin sent must NOT have refilled the completion the cancel drained.
    expect(runner.takeCompletion(sessionId)).toBeUndefined()
    expect(stopped.length).toBe(1)
  })

  it("never sends a step for a session cancelled while its address was being re-checked", async () => {
    const gate = deferred()
    const { runner, calls } = harness({
      steps: [formStep, formStep],
      ensureGate: gate.promise,
      ensureGateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""

    const inFlight = runner.advance({ sessionId, result: { kind: "ack" } })
    await runner.cancel(sessionId)
    gate.release()
    const raced = await inFlight

    expect(raced.ok).toBe(false)
    if (!raced.ok) expect(raced.error.kind).toBe("not-found")
    // Only the opening call: the cancelled session never reached the plugin.
    expect(calls.length).toBe(1)
  })

  it("delivers the named cause to the very call a session was abandoned under", async () => {
    // The plugin's step is discarded — its child is being killed — but the CALLER is right
    // here, awaiting this call. Holding the named cause back for a "next call" that a UI
    // which stops polling on failure will never make is how the reason gets lost.
    const gate = deferred()
    const { runner, started: instances } = harness({
      steps: [formStep, formStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const started = await runner.start(startInput)
    const sessionId = started.ok ? started.value.sessionId : ""

    const inFlight = runner.advance({ sessionId, result: { kind: "ack" } })
    await flush()
    runner.abandon([instances[0]?.instanceKey ?? ""], "extension-disabled")
    gate.release()
    const raced = await inFlight

    // Asserted unconditionally: a combined `if (raced.ok && kind === "error")` would pass
    // vacuously on any other kind.
    expect(raced.ok).toBe(true)
    if (!raced.ok) return
    expect(raced.value.step.kind).toBe("error")
    if (raced.value.step.kind === "error")
      expect(raced.value.step.message).toContain("no longer available")

    // Drained by that delivery, so a replayed call gets the ordinary terminal answer.
    const after = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("not-found")
  })
})

describe("createFlowRunner deadline", () => {
  it("arms a deadline for the whole flow budget when the flow starts", async () => {
    const { runner, timers } = harness({ steps: [formStep] })
    await runner.start(startInput)
    expect(timers.map((t) => t.ms)).toEqual([FLOW_LIMITS.totalTimeoutMs])
  })

  it("stops the flow instance when the deadline fires", async () => {
    const { runner, stopped, fireTimers } = harness({ steps: [formStep] })
    await runner.start(startInput)
    fireTimers()
    await flush()
    expect(stopped.length).toBe(1)
  })

  it("names the timeout when the caller advances after the deadline fired", async () => {
    // `not-found` here would be indistinguishable from a session id the caller invented, and
    // the GUI's copy for it blames the extension for not offering the flow. The deadline is
    // the only thing that knows a flow was killed for running too long, so it has to say so.
    const { runner, fireTimers } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    fireTimers()
    await flush()
    const after = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.step.kind).toBe("error")
    if (after.value.step.kind !== "error") return
    expect(after.value.step.message).toContain("longer than 10 minutes")
  })

  it("names the timeout when the deadline fires while a step call is in flight", async () => {
    const gate = deferred()
    const { runner, fireTimers } = harness({
      steps: [formStep, formStep],
      callGate: gate.promise,
      gateFrom: 2,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const pending = runner.advance({ sessionId, result: { kind: "ack" } })
    await flush()
    fireTimers()
    await flush()
    gate.release()
    const after = await pending
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.step.kind).toBe("error")
    if (after.value.step.kind !== "error") return
    expect(after.value.step.message).toContain("longer than 10 minutes")
  })

  it("names the timeout when the deadline fires while the address re-check is in flight", async () => {
    const gate = deferred()
    const { runner, fireTimers } = harness({
      steps: [formStep, formStep],
      ensureGate: gate.promise,
      ensureGateFrom: 2,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    const pending = runner.advance({ sessionId, result: { kind: "ack" } })
    await flush()
    fireTimers()
    await flush()
    gate.release()
    const after = await pending
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.step.kind).toBe("error")
  })

  it("drains the timeout message so a replayed call gets not-found", async () => {
    // Exactly like the abandon path: the flow is over, so a second call must not keep
    // receiving an error step that never stops arriving.
    const { runner, fireTimers } = harness({ steps: [formStep, formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    fireTimers()
    await flush()
    await runner.advance({ sessionId, result: { kind: "ack" } })
    const again = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.kind).toBe("not-found")
  })

  it("forgets a timed-out session's completion rather than leaving it takeable", async () => {
    const { runner, fireTimers } = harness({ steps: [formStep] })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    fireTimers()
    await flush()
    expect(runner.takeCompletion(sessionId)).toBeUndefined()
  })

  it("drops the flow key from the active set when the deadline fires", async () => {
    const { runner, fireTimers } = harness({ steps: [formStep] })
    await runner.start(startInput)
    fireTimers()
    await flush()
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("clears the deadline when the flow completes", async () => {
    const { runner, timers } = harness({ steps: [doneStep] })
    await runner.start(startInput)
    expect(timers.length).toBe(0)
  })

  it("clears the deadline when the flow is cancelled", async () => {
    const { runner, timers } = harness({ steps: [formStep] })
    const r = await runner.start(startInput)
    await runner.cancel(r.ok ? r.value.sessionId : "")
    expect(timers.length).toBe(0)
  })

  it("arms no deadline when the flow instance never starts", async () => {
    const { runner, timers } = harness({
      steps: [formStep],
      ensureFails: { kind: "not-found", id: "acme" },
    })
    await runner.start(startInput)
    expect(timers.length).toBe(0)
  })

  it("gives the opening call the whole budget", async () => {
    const { runner, calls } = harness({ steps: [formStep] })
    await runner.start(startInput)
    expect(calls[0]?.timeoutMs).toBe(FLOW_LIMITS.totalTimeoutMs)
  })

  it("gives each later call only what is left of the budget", async () => {
    const { runner, calls } = harness({
      steps: [formStep, formStep],
      nowStepMs: 100_000,
    })
    const first = await runner.start(startInput)
    const sessionId = first.ok ? first.value.sessionId : ""
    await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(calls[1]?.timeoutMs).toBe(FLOW_LIMITS.totalTimeoutMs - 100_000)
  })

  it("ends a flow whose deadline fires while its opening call is in flight", async () => {
    const gate = deferred()
    const { runner, fireTimers, stopped } = harness({
      steps: [formStep],
      callGate: gate.promise,
    })
    const pending = runner.start(startInput)
    await flush()
    fireTimers()
    await flush()
    gate.release()
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("read-failed")
      if (r.error.kind === "read-failed")
        expect(r.error.detail).toContain("total timeout")
    }
    expect(stopped.length).toBe(1)
  })

  it("registers no session for a flow whose deadline fired while starting", async () => {
    const gate = deferred()
    const { runner, fireTimers } = harness({
      steps: [formStep],
      callGate: gate.promise,
    })
    const pending = runner.start(startInput)
    await flush()
    fireTimers()
    await flush()
    gate.release()
    await pending
    expect([...runner.activeInstanceKeys()]).toEqual([])
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
    if (second.value.step.kind === "error") {
      expect(second.value.step.message).toContain("no longer available")
      // The ONE reason covers three causes — the user disabling the extension, an uninstall
      // (`ExtensionAdmin.remove`), and a refresh that dropped the contribution — so the copy
      // must name both, not just the disable it is named after.
      expect(second.value.step.message).toContain("disabled or removed")
      // And it must still say the half-finished exchange was not persisted.
      expect(second.value.step.message).toContain("were not saved")
    }
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

  it("clears an abandoned flow's deadline", async () => {
    const { runner, started, timers } = harness({ steps: [formStep, formStep] })
    await runner.start(startInput)
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    expect(timers.length).toBe(0)
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

  it("ends a flow abandoned while its opening call is in flight", async () => {
    // `activeInstanceKeys()` reports this key, so the sweep hands it to `abandon` — and the
    // user must see the named cause, not the transport failure of a killed child.
    const gate = deferred()
    const { runner, started } = harness({
      steps: [formStep],
      callGate: gate.promise,
    })
    const pending = runner.start(startInput)
    await flush()
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    gate.release()
    const r = await pending
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.step.kind).toBe("error")
    if (r.value.step.kind === "error")
      expect(r.value.step.message).toContain("no longer available")
  })

  it("ends a flow abandoned while its instance is still spawning", async () => {
    const gate = deferred()
    const { runner, started, calls } = harness({
      steps: [formStep],
      ensureGate: gate.promise,
    })
    const pending = runner.start(startInput)
    await flush()
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    gate.release()
    const r = await pending
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.step.kind).toBe("error")
    if (r.value.step.kind === "error")
      expect(r.value.step.message).toContain("no longer available")
    // Nothing was ever said to the child: it is about to be swept, and the opening call
    // would have carried the host token to a process that is being killed.
    expect(calls.length).toBe(0)
  })

  it("names the abandon even when the spawn it interrupted then fails", async () => {
    // `retainOnly` lands while `ensureRunning` is still inside `waitForReady` (which polls
    // for seconds): the host's generation guard fails the start, so the flow sees a
    // supervisor error whose actual cause was the user's own "disable extension" click.
    const gate = deferred()
    const { runner, started } = harness({
      steps: [formStep],
      ensureGate: gate.promise,
      ensureFails: {
        kind: "write-failed",
        detail: "start superseded by a stop or a newer start",
      },
    })
    const pending = runner.start(startInput)
    await flush()
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    gate.release()
    const r = await pending

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.step.kind).toBe("error")
    if (r.value.step.kind === "error")
      expect(r.value.step.message).toContain("no longer available")
    expect([...runner.activeInstanceKeys()]).toEqual([])
  })

  it("registers no session for a flow abandoned while starting", async () => {
    const gate = deferred()
    const { runner, started } = harness({
      steps: [formStep],
      callGate: gate.promise,
    })
    const pending = runner.start(startInput)
    await flush()
    runner.abandon([started[0]?.instanceKey ?? ""], "extension-disabled")
    gate.release()
    const r = await pending
    expect([...runner.activeInstanceKeys()]).toEqual([])
    const sessionId = r.ok ? r.value.sessionId : ""
    const after = await runner.advance({ sessionId, result: { kind: "ack" } })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("not-found")
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

  it("logs the outcome when a flow's deadline fires", async () => {
    const { logger, entries } = captureLogger()
    const { runner, fireTimers } = harness({ steps: [formStep], logger })
    await runner.start(startInput)
    fireTimers()
    await flush()
    expect(entries.some((e) => e.fields?.outcome === "timeout")).toBe(true)
  })
})
