import type {
  FlowResponse,
  FlowResult,
  FlowStep,
  FlowToast,
  PluginError,
} from "@spectrum/extensions"
import { FLOW_LIMITS, clampPollMs } from "@spectrum/extensions"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import { type Result, err, ok } from "@spectrum/utils"
import type { FlowClient } from "./flow-client"
import type { ProviderHost } from "./host"

/**
 * A SPECTRUM-side flow session id, minted by the runner and handed to the IPC caller. It is
 * not the plugin's session id: the plugin mints its own (held in session state as
 * `pluginSessionId`) and the two are never interchanged. Keeping Spectrum's handle out of the
 * plugin's namespace means a plugin cannot name a session it was not given.
 */
export type FlowSessionId = string

export type RunnerStep = {
  readonly sessionId: FlowSessionId
  readonly step: FlowStep
  readonly toast?: FlowToast
}

/** The credential payload a `done` step carried, held for exactly one `takeCompletion`. */
export type FlowCompletion = {
  readonly config: Record<string, string>
  readonly secrets: Record<string, string>
}

export type FlowStartInput = {
  /** The provider CONTRIBUTION id (the part after `plugin:`), not a Spectrum ProviderId. */
  readonly providerId: string
  readonly flowId: string
  readonly context: "create" | "provider"
  readonly config: Readonly<Record<string, string>>
  /** Only meaningful for `context: "provider"` — a provider being created has no secrets. */
  readonly secrets?: Readonly<Record<string, string>>
}

export type FlowAdvanceInput = {
  readonly sessionId: FlowSessionId
  readonly result: FlowResult
}

/** Why a live flow was killed from outside. One member today; the map below keys off it. */
export type FlowAbandonReason = "extension-disabled"

/** Opaque timer handle, whatever the injected timer returns. */
export type FlowTimerHandle = unknown

export interface FlowRunner {
  start(input: FlowStartInput): Promise<Result<RunnerStep, PluginError>>
  advance(input: FlowAdvanceInput): Promise<Result<RunnerStep, PluginError>>
  /** Consumes the payload: returns it once, then never again. */
  takeCompletion(sessionId: FlowSessionId): FlowCompletion | undefined
  cancel(sessionId: FlowSessionId): Promise<void>
  /** The keys of every live flow instance, for the composition root's retention sweep. */
  activeInstanceKeys(): ReadonlySet<string>
  /**
   * Mark every flow running on one of `keys` terminal, with an `error` step naming why.
   *
   * The caller stops the instances; this is the notification half. `retainOnly` stops and
   * FORGETS an instance with no callback and no reason code, and `host.status` reports
   * `"stopped"` identically for a swept instance, a crashed one, and a key that never
   * existed — so the runner cannot discover why its child died and must be told. The
   * composition root calls this immediately BEFORE `retainOnly`, which is what turns a
   * mid-flow "disable this extension" into an actionable message instead of a flow that
   * hangs against a dead process until its deadline expires.
   *
   * Covers flows still inside their opening window as well as established sessions: a key
   * reported by `activeInstanceKeys()` may have no session yet, and that flow must produce
   * the same named error rather than the raw transport failure of talking to a killed child.
   */
  abandon(keys: readonly string[], reason: FlowAbandonReason): void
}

export type FlowRunnerDeps = {
  readonly host: ProviderHost
  readonly client: FlowClient
  /**
   * Mints BOTH the instance-key nonce and the Spectrum session id — deliberately, and from
   * one unguessable source (`crypto.randomUUID` in the composition root). The session id is
   * a capability handle held by the IPC caller and the nonce keeps two concurrent flows for
   * one contribution on separate children; neither may be guessable from the other.
   */
  readonly idGen: () => string
  readonly now: () => number
  /**
   * The flow's wall-clock deadline. `now` alone bounds nothing: it is only read when a call
   * arrives, so a user who closes the setup window without cancelling would leave the child
   * running forever. Injected rather than `setTimeout` so tests fire the deadline instead of
   * waiting ten minutes.
   */
  readonly setTimer: (ms: number, onFire: () => void) => FlowTimerHandle
  readonly clearTimer: (handle: FlowTimerHandle) => void
  readonly logger?: Logger
}

/**
 * Marks an instance key as belonging to a setup flow rather than to a provider record.
 * `providerInstanceKey` (`@spectrum/proxy`) emits JSON, so the two spaces cannot collide.
 */
const FLOW_KEY_PREFIX = "flow:"

/** The instance key for one run of one flow. The nonce keeps two concurrent flows apart. */
export const flowInstanceKey = (providerId: string, nonce: string): string =>
  `${FLOW_KEY_PREFIX}${providerId}:${nonce}`

/**
 * Pure: the provider CONTRIBUTION id inside a flow instance key, or undefined when the key
 * is not a flow key. The caller maps that contribution id to an extension manifest id — they
 * are different id spaces and a contribution id is never an extension id.
 */
export const flowContributionIdOf = (key: string): string | undefined => {
  if (!key.startsWith(FLOW_KEY_PREFIX)) return undefined
  const rest = key.slice(FLOW_KEY_PREFIX.length)
  const split = rest.lastIndexOf(":")
  if (split <= 0 || split === rest.length - 1) return undefined
  return rest.slice(0, split)
}

/**
 * One member, three causes. The composition root uses `extension-disabled` for a flow the
 * user disabled, for one whose contribution is no longer installed (an uninstall, or a
 * refresh that dropped it), and for a key that names no contribution at all — and
 * `ExtensionAdmin.remove` uses it for an uninstall too. The copy therefore has to be true of
 * all of them, so it says "disabled or removed" rather than naming only the disable. Widening
 * `FlowAbandonReason` to distinguish them would buy nothing the user can act on differently:
 * the action is the same in every case, and it is their own click either way.
 */
const ABANDON_MESSAGE: Record<FlowAbandonReason, string> = {
  "extension-disabled":
    "This extension is no longer available — it was disabled or removed while this setup " +
    "was running, so it was stopped. Any credentials it had already exchanged were not saved.",
}

const TIMEOUT_DETAIL = `flow exceeded its ${FLOW_LIMITS.totalTimeoutMs} ms total timeout`

/**
 * The `detail` carried by the `read-failed` that refuses a SECOND concurrent `advance`.
 *
 * Exported because that refusal is deliberately NOT terminal while every other `read-failed`
 * is, and `kind` alone cannot tell them apart: a caller that surfaces failures to a user has
 * to distinguish "you clicked twice" from "the extension died", and must not have to hand-copy
 * this string to do it.
 */
export const FLOW_IN_FLIGHT_DETAIL = "a flow step is already in flight"

type Session = {
  readonly instanceKey: string
  readonly providerId: string
  readonly flowId: string
  readonly baseUrl: string
  readonly hostToken: string | undefined
  readonly pid: number
  /**
   * What the flow's child was started with, kept so the address re-check can call
   * `ensureRunning` idempotently without handing the supervisor a different environment.
   */
  readonly secrets: Readonly<Record<string, string>>
  /** The id the PLUGIN minted for this exchange — its namespace, never Spectrum's. */
  readonly pluginSessionId: string
  stepCount: number
  readonly startedAt: number
  /** True while a call to the plugin is outstanding; a second `advance` is refused. */
  inFlight: boolean
}

/** A flow whose child exists but whose first step has not arrived yet. */
type Starting = { readonly providerId: string; readonly flowId: string }

/** How a flow still inside its opening window was killed from outside. */
type Interrupt = FlowAbandonReason | "timeout"

type Outcome =
  | "done"
  | "error"
  | "cancelled"
  | "timeout"
  | "step-cap"
  | "failed"
  | FlowAbandonReason

/**
 * Drives one setup flow: spawns a DEDICATED instance (`flow:<providerId>:<nonce>`), relays
 * steps, and enforces every cap itself rather than trusting the extension.
 *
 * The instance is separate from any serving instance because in `context: "create"` there
 * is no provider record yet — no config, no secrets — and because a flow that hangs must
 * never take a working provider down with it. It is stopped on done, error, cancel, the
 * deadline, the elapsed-budget check, step-cap exhaustion, a moved address, and a failed or
 * unparseable response. `abandon` is the single exception: its caller stops the instances
 * itself (see `abandon` below), which is the whole reason it exists.
 *
 * A flow does not survive its child. The supervisor restarts a crashed instance on a NEW
 * port with a NEW host token, so an address captured at `start` is not a fact that stays
 * true: every call re-obtains it and ends the flow if it moved.
 *
 * `activeInstanceKeys` exists because the composition root's retention sweep
 * (`retainConfiguredInstances`) builds its retain-set from configured providers only. A flow
 * key belongs to no provider record, so without this the first `config.save` during a flow
 * would stop the flow's own child.
 */
export const createFlowRunner = (deps: FlowRunnerDeps): FlowRunner => {
  const logger = deps.logger ?? createNoopLogger()
  const sessions = new Map<FlowSessionId, Session>()
  /**
   * Instance keys whose child exists but whose first step has not arrived yet. They are live
   * for the retention sweep exactly like a session's key is — a sweep landing in that window
   * would otherwise stop the child the opening call is talking to.
   */
  const starting = new Map<string, Starting>()
  /** Keys killed from outside while still in `starting`, read by the in-flight `start`. */
  const interrupted = new Map<string, Interrupt>()
  const completions = new Map<FlowSessionId, FlowCompletion>()
  /** Session id → the user-facing message its next `advance` must deliver, then forget. */
  const abandoned = new Map<FlowSessionId, string>()
  const deadlines = new Map<string, FlowTimerHandle>()

  const logEnd = (
    providerId: string,
    flowId: string,
    outcome: Outcome,
  ): void => {
    logger.info("flow ended", { providerId, flowId, outcome })
  }

  const disarm = (instanceKey: string): void => {
    const handle = deadlines.get(instanceKey)
    if (handle === undefined) return
    deadlines.delete(instanceKey)
    deps.clearTimer(handle)
  }

  /** Every terminal path funnels through here: forget the flow, then stop the child. */
  const end = async (
    sessionId: FlowSessionId,
    session: Session,
    outcome: Outcome,
  ): Promise<void> => {
    sessions.delete(sessionId)
    disarm(session.instanceKey)
    logEnd(session.providerId, session.flowId, outcome)
    await deps.host.stop(session.instanceKey)
  }

  /** The deadline fired: whatever stage the flow reached, it is over and the child dies. */
  const expire = async (instanceKey: string): Promise<void> => {
    deadlines.delete(instanceKey)
    for (const [sessionId, session] of [...sessions])
      if (session.instanceKey === instanceKey) {
        completions.delete(sessionId)
        await end(sessionId, session, "timeout")
        return
      }
    const pending = starting.get(instanceKey)
    if (pending === undefined) return
    starting.delete(instanceKey)
    interrupted.set(instanceKey, "timeout")
    logEnd(pending.providerId, pending.flowId, "timeout")
    await deps.host.stop(instanceKey)
  }

  const arm = (instanceKey: string): void => {
    deadlines.set(
      instanceKey,
      deps.setTimer(FLOW_LIMITS.totalTimeoutMs, () => {
        expire(instanceKey).catch((cause: unknown) => {
          logger.error("flow deadline handling failed", {
            detail: cause instanceof Error ? cause.message : String(cause),
          })
        })
      }),
    )
  }

  /**
   * The outcome an opening call must return when its flow was killed while it was in flight,
   * or undefined when it was not. The session id minted for the abandoned case is
   * deliberately never registered: the flow is over, so any further call gets `not-found`.
   */
  const resolveInterrupt = (
    instanceKey: string,
  ): Result<RunnerStep, PluginError> | undefined => {
    const why = interrupted.get(instanceKey)
    if (why === undefined) return undefined
    interrupted.delete(instanceKey)
    // Neither branch stops the child: the timeout path already did, and the abandon path
    // belongs to the caller that is about to sweep it.
    if (why === "timeout")
      return err({ kind: "read-failed", detail: TIMEOUT_DETAIL })
    return ok({
      sessionId: deps.idGen(),
      step: { kind: "error", message: ABANDON_MESSAGE[why] },
    })
  }

  const deliver = async (
    sessionId: FlowSessionId,
    session: Session,
    response: FlowResponse,
  ): Promise<Result<RunnerStep, PluginError>> => {
    // The caller must never see the plugin's raw number, or a UI that trusts it will poll at
    // whatever rate the plugin chose.
    const step: FlowStep =
      response.step.kind === "await"
        ? { ...response.step, pollMs: clampPollMs(response.step.pollMs) }
        : response.step

    logger.debug("flow step", { kind: step.kind })

    if (step.kind === "done") {
      // The completion — not the returned step — is `done.secrets`' path to the keychain.
      // The step still carries what the plugin sent; it is the IPC handler that sanitizes it
      // before anything crosses to the renderer. Draining the payload here is what stops a
      // replayed call from re-reading it.
      completions.set(sessionId, {
        config: { ...(step.config ?? {}) },
        secrets: { ...(step.secrets ?? {}) },
      })
      await end(sessionId, session, "done")
    } else if (step.kind === "error") {
      await end(sessionId, session, "error")
    }

    return ok({
      sessionId,
      step,
      ...(response.toast === undefined ? {} : { toast: response.toast }),
    })
  }

  const start = async (
    input: FlowStartInput,
  ): Promise<Result<RunnerStep, PluginError>> => {
    const instanceKey = flowInstanceKey(input.providerId, deps.idGen())
    logger.info("flow starting", {
      providerId: input.providerId,
      flowId: input.flowId,
      context: input.context,
    })

    // A provider being created has no secrets yet; passing the caller's would hand the
    // flow's child credentials the user never associated with it.
    const secrets = input.context === "provider" ? (input.secrets ?? {}) : {}

    // Registered BEFORE the spawn: from here on a retention sweep must see the key.
    starting.set(instanceKey, {
      providerId: input.providerId,
      flowId: input.flowId,
    })
    const running = await deps.host.ensureRunning({
      instanceKey,
      providerId: input.providerId,
      secrets,
    })
    if (!running.ok) {
      starting.delete(instanceKey)
      // An interrupt recorded while the spawn was still in flight OUTRANKS the supervisor's
      // error. `waitForReady` polls for seconds, and the sweep that killed this child is
      // precisely why `ensureRunning` then failed — reporting the raw supervisor error here
      // would send the user hunting a bug that is their own "disable extension" click.
      const interruptedSpawn = resolveInterrupt(instanceKey)
      if (interruptedSpawn !== undefined) return interruptedSpawn
      logEnd(input.providerId, input.flowId, "failed")
      return running
    }

    const atSpawn = resolveInterrupt(instanceKey)
    if (atSpawn !== undefined) return atSpawn

    arm(instanceKey)
    const startedAt = deps.now()
    const called = await deps.client.start(
      running.value.baseUrl,
      running.value.hostToken,
      input.flowId,
      { context: input.context, config: input.config },
      FLOW_LIMITS.totalTimeoutMs,
    )

    const duringCall = resolveInterrupt(instanceKey)
    if (duringCall !== undefined) return duringCall
    starting.delete(instanceKey)

    if (!called.ok) {
      disarm(instanceKey)
      logEnd(input.providerId, input.flowId, "failed")
      await deps.host.stop(instanceKey)
      return called
    }

    const sessionId = deps.idGen()
    const session: Session = {
      instanceKey,
      providerId: input.providerId,
      flowId: input.flowId,
      baseUrl: running.value.baseUrl,
      hostToken: running.value.hostToken,
      pid: running.value.pid,
      secrets,
      pluginSessionId: called.value.sessionId,
      stepCount: 1,
      startedAt,
      inFlight: false,
    }
    sessions.set(sessionId, session)
    return deliver(sessionId, session, called.value)
  }

  /**
   * Re-obtain the child's address instead of trusting the one captured at `start`.
   *
   * A crashed instance is restarted on a fresh port with a fresh host token, and the freed
   * port is an impersonation window. Posting a form result — the credentials the user just
   * typed — plus the host token to whatever now owns that port is the failure this prevents.
   * A restarted child is also a new process with no memory of `pluginSessionId`, so there is
   * nothing to recover: the flow ends.
   *
   * The status gate comes first so a flow never RESURRECTS a child that was stopped or swept
   * — `ensureRunning` would happily spawn a new one.
   */
  const verifyAddress = async (
    session: Session,
  ): Promise<Result<undefined, PluginError>> => {
    if (deps.host.status(session.instanceKey) !== "running")
      return err({
        kind: "read-failed",
        detail: "flow instance is no longer running",
      })
    const running = await deps.host.ensureRunning({
      instanceKey: session.instanceKey,
      providerId: session.providerId,
      secrets: session.secrets,
    })
    if (!running.ok) return running
    if (
      running.value.baseUrl !== session.baseUrl ||
      running.value.hostToken !== session.hostToken ||
      running.value.pid !== session.pid
    )
      return err({ kind: "read-failed", detail: "flow instance restarted" })
    return ok(undefined)
  }

  const advance = async (
    input: FlowAdvanceInput,
  ): Promise<Result<RunnerStep, PluginError>> => {
    const message = abandoned.get(input.sessionId)
    if (message !== undefined) {
      // Drained on delivery: the flow is over, so a replayed call gets `not-found` like any
      // other terminal path rather than an error step that never stops arriving.
      abandoned.delete(input.sessionId)
      return ok({
        sessionId: input.sessionId,
        step: { kind: "error", message },
      })
    }

    const session = sessions.get(input.sessionId)
    if (session === undefined)
      return err({ kind: "not-found", id: input.sessionId })

    // Not terminal: a double-click or a poll racing a submit is a caller mistake, not a
    // reason to kill the flow. Refusing here is also what keeps the completion map's
    // "drained by exactly one take" true — two deliveries could otherwise refill it.
    if (session.inFlight)
      return err({ kind: "read-failed", detail: FLOW_IN_FLIGHT_DETAIL })

    const elapsed = deps.now() - session.startedAt
    if (elapsed > FLOW_LIMITS.totalTimeoutMs) {
      await end(input.sessionId, session, "timeout")
      return err({ kind: "read-failed", detail: TIMEOUT_DETAIL })
    }

    if (session.stepCount >= FLOW_LIMITS.maxSteps) {
      await end(input.sessionId, session, "step-cap")
      return err({
        kind: "read-failed",
        detail: `flow exceeded ${FLOW_LIMITS.maxSteps} steps`,
      })
    }

    /** Did this session get ended (cancel, abandon, deadline) while we were suspended? */
    const orphaned = (): boolean => sessions.get(input.sessionId) !== session

    session.inFlight = true
    try {
      const verified = await verifyAddress(session)
      if (orphaned()) return err({ kind: "not-found", id: input.sessionId })
      if (!verified.ok) {
        await end(input.sessionId, session, "failed")
        return verified
      }

      session.stepCount += 1
      const called = await deps.client.next(
        session.baseUrl,
        session.hostToken,
        session.flowId,
        { sessionId: session.pluginSessionId, result: input.result },
        // Whatever is left of the flow's budget, so one unanswered call cannot outlive it.
        Math.max(1, FLOW_LIMITS.totalTimeoutMs - elapsed),
      )
      if (orphaned()) return err({ kind: "not-found", id: input.sessionId })

      if (!called.ok) {
        await end(input.sessionId, session, "failed")
        return called
      }
      return await deliver(input.sessionId, session, called.value)
    } finally {
      session.inFlight = false
    }
  }

  return {
    start,
    advance,
    takeCompletion: (sessionId: FlowSessionId): FlowCompletion | undefined => {
      const completion = completions.get(sessionId)
      // Dropped after one read, so a replayed IPC call cannot re-read the secrets.
      completions.delete(sessionId)
      return completion
    },
    cancel: async (sessionId: FlowSessionId): Promise<void> => {
      // A cancelled flow's untaken completion is dropped rather than left in memory: it holds
      // raw secret values that now belong to no provider record.
      completions.delete(sessionId)
      abandoned.delete(sessionId)
      const session = sessions.get(sessionId)
      if (session === undefined) return
      await end(sessionId, session, "cancelled")
    },
    activeInstanceKeys: (): ReadonlySet<string> =>
      new Set([
        ...starting.keys(),
        ...[...sessions.values()].map((session) => session.instanceKey),
      ]),
    abandon: (keys: readonly string[], reason: FlowAbandonReason): void => {
      const dropped = new Set(keys)
      for (const [sessionId, session] of [...sessions])
        if (dropped.has(session.instanceKey)) {
          sessions.delete(sessionId)
          completions.delete(sessionId)
          abandoned.set(sessionId, ABANDON_MESSAGE[reason])
          disarm(session.instanceKey)
          logEnd(session.providerId, session.flowId, reason)
        }
      for (const [instanceKey, pending] of [...starting])
        if (dropped.has(instanceKey)) {
          starting.delete(instanceKey)
          interrupted.set(instanceKey, reason)
          disarm(instanceKey)
          logEnd(pending.providerId, pending.flowId, reason)
        }
    },
  }
}
