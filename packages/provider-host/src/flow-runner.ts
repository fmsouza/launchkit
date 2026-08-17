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

export interface FlowRunner {
  start(input: FlowStartInput): Promise<Result<RunnerStep, PluginError>>
  advance(input: FlowAdvanceInput): Promise<Result<RunnerStep, PluginError>>
  /** Consumes the payload: returns it once, then never again. */
  takeCompletion(sessionId: FlowSessionId): FlowCompletion | undefined
  cancel(sessionId: FlowSessionId): Promise<void>
  /** The keys of every live flow instance, for the composition root's retention sweep. */
  activeInstanceKeys(): ReadonlySet<string>
  /**
   * Mark every session running on one of `keys` terminal, with an `error` step naming why.
   *
   * The caller stops the instances; this is the notification half. `retainOnly` stops and
   * FORGETS an instance with no callback and no reason code, and `host.status` reports
   * `"stopped"` identically for a swept instance, a crashed one, and a key that never
   * existed — so the runner cannot discover why its child died and must be told. The
   * composition root calls this immediately BEFORE `retainOnly`, which is what turns a
   * mid-flow "disable this extension" into an actionable message instead of a flow that
   * hangs against a dead process until its 10-minute timeout expires.
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

const ABANDON_MESSAGE: Record<FlowAbandonReason, string> = {
  "extension-disabled":
    "This extension is no longer enabled — it was disabled while this setup was running, " +
    "so it was stopped. Any credentials it had already exchanged were not saved.",
}

type Session = {
  readonly instanceKey: string
  readonly providerId: string
  readonly flowId: string
  readonly baseUrl: string
  readonly hostToken: string | undefined
  /** The id the PLUGIN minted for this exchange — its namespace, never Spectrum's. */
  readonly pluginSessionId: string
  stepCount: number
  readonly startedAt: number
}

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
 * never take a working provider down with it. It is stopped on done, error, cancel,
 * timeout, step-cap exhaustion, and on a failed or unparseable response, on every path.
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
  const starting = new Set<string>()
  const completions = new Map<FlowSessionId, FlowCompletion>()
  /** Session id → the user-facing message its next `advance` must deliver, then forget. */
  const abandoned = new Map<FlowSessionId, string>()

  const logEnd = (
    providerId: string,
    flowId: string,
    outcome: Outcome,
  ): void => {
    logger.info("flow ended", { providerId, flowId, outcome })
  }

  /** Every terminal path funnels through here: forget the session, then stop the child. */
  const end = async (
    sessionId: FlowSessionId,
    session: Session,
    outcome: Outcome,
  ): Promise<void> => {
    sessions.delete(sessionId)
    logEnd(session.providerId, session.flowId, outcome)
    await deps.host.stop(session.instanceKey)
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

    // Registered BEFORE the spawn: from here on a retention sweep must see the key.
    starting.add(instanceKey)
    const running = await deps.host.ensureRunning({
      instanceKey,
      providerId: input.providerId,
      // A provider being created has no secrets yet; passing the caller's would hand the
      // flow's child credentials the user never associated with it.
      secrets: input.context === "provider" ? (input.secrets ?? {}) : {},
    })
    if (!running.ok) {
      starting.delete(instanceKey)
      logEnd(input.providerId, input.flowId, "failed")
      return running
    }

    const startedAt = deps.now()
    const called = await deps.client.start(
      running.value.baseUrl,
      running.value.hostToken,
      input.flowId,
      { context: input.context, config: input.config },
    )
    starting.delete(instanceKey)
    if (!called.ok) {
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
      pluginSessionId: called.value.sessionId,
      stepCount: 1,
      startedAt,
    }
    sessions.set(sessionId, session)
    return deliver(sessionId, session, called.value)
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

    if (deps.now() - session.startedAt > FLOW_LIMITS.totalTimeoutMs) {
      await end(input.sessionId, session, "timeout")
      return err({
        kind: "read-failed",
        detail: `flow exceeded its ${FLOW_LIMITS.totalTimeoutMs} ms total timeout`,
      })
    }

    if (session.stepCount >= FLOW_LIMITS.maxSteps) {
      await end(input.sessionId, session, "step-cap")
      return err({
        kind: "read-failed",
        detail: `flow exceeded ${FLOW_LIMITS.maxSteps} steps`,
      })
    }
    session.stepCount += 1

    const called = await deps.client.next(
      session.baseUrl,
      session.hostToken,
      session.flowId,
      { sessionId: session.pluginSessionId, result: input.result },
    )
    if (!called.ok) {
      await end(input.sessionId, session, "failed")
      return called
    }
    return deliver(input.sessionId, session, called.value)
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
        ...starting,
        ...[...sessions.values()].map((session) => session.instanceKey),
      ]),
    abandon: (keys: readonly string[], reason: FlowAbandonReason): void => {
      const dropped = new Set(keys)
      for (const [sessionId, session] of [...sessions])
        if (dropped.has(session.instanceKey)) {
          sessions.delete(sessionId)
          completions.delete(sessionId)
          abandoned.set(sessionId, ABANDON_MESSAGE[reason])
          logEnd(session.providerId, session.flowId, reason)
        }
    },
  }
}
