import type {
  ExtensionRegistry,
  LoadedExtension,
  PluginError,
  PluginLaunch,
  ProviderContribution,
} from "@spectrum/extensions"
import { renderPluginArgs, renderPluginEnv } from "@spectrum/extensions"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import type {
  CommandResolver,
  ProcessSpawner,
  SpawnedProcess,
} from "@spectrum/proc"
import { guardCommand } from "@spectrum/proc"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import type { TokenGen } from "./host-token"
import type { PortAllocator } from "./port"
import { type HealthProbe, type Sleep, waitForReady } from "./readiness"

export type PluginStatus = "stopped" | "starting" | "running" | "failed"

export type RunningPlugin = {
  readonly baseUrl: string
  readonly pid: number
  readonly hostToken: string | undefined
}

export type EnsureRunningInput = {
  /**
   * The proxy factory's provider cache key — a hash of `{sdkProvider, config, secretRefs}`.
   * One supervised process per distinct provider CONFIGURATION, not per contribution:
   * two Provider records can target one contribution with different API keys, and a single
   * process would make "whose secrets go in the env" ambiguous.
   */
  readonly instanceKey: string
  /** The provider CONTRIBUTION id (the part after `plugin:`), not a Spectrum ProviderId. */
  readonly providerId: string
  readonly secrets: Readonly<Record<string, string>>
}

export interface ProviderHost {
  ensureRunning(
    input: EnsureRunningInput,
  ): Promise<Result<RunningPlugin, PluginError>>
  status(instanceKey: string): PluginStatus
  stop(instanceKey: string): Promise<void>
  stopAllFor(providerId: string): Promise<void>
  stopAll(): Promise<void>
  /**
   * Stop and forget every instance whose key is not in `instanceKeys`.
   *
   * The composition root calls this whenever the live config changes and on every extension
   * refresh. Without it the host retains a child per historical provider CONFIGURATION: an
   * instance key is derived from the provider's config and secret refs, so editing one field
   * spawns a new child while the previous one stays `running` forever, still holding the old
   * secrets in its environment.
   */
  retainOnly(instanceKeys: ReadonlySet<string>): Promise<void>
}

export type ProviderHostDeps = {
  readonly registry: ExtensionRegistry
  /**
   * Whether an installed extension (by MANIFEST id) is enabled in the user's config.
   *
   * SECURITY: `registry.list()` reports every extension on disk, enabled or not. Without this
   * gate a disabled extension's `launch.command` is spawnable the moment anything asks for a
   * contribution id it declares — with the resolved secrets of whichever provider record named
   * that id rendered into its environment.
   */
  readonly isEnabled: (extensionId: string) => boolean
  readonly resolver: CommandResolver
  readonly spawner: ProcessSpawner
  readonly allocator: PortAllocator
  readonly probe: HealthProbe
  readonly sleep: Sleep
  readonly now: () => number
  readonly tokenGen: TokenGen
  readonly logger?: Logger
  readonly maxRestarts?: number
}

const LOOPBACK = "127.0.0.1"
const DEFAULT_MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = 250
const MAX_RESTART_BACKOFF_MS = 5000
/**
 * How long an instance must stay ready before its crash counts as an isolated incident
 * rather than another turn of a crash loop. `maxRestarts` is a budget for CONSECUTIVE
 * failures: without this window a plugin that crashes once a month would exhaust its
 * lifetime budget and stay `failed` forever, and with a naive reset-on-ready a plugin that
 * dies one millisecond after binding its port would restart without limit.
 */
const STABLE_UPTIME_MS = 60_000

type Instance = {
  status: PluginStatus
  readonly providerId: string
  secrets: Readonly<Record<string, string>>
  process: SpawnedProcess | undefined
  baseUrl: string | undefined
  hostToken: string | undefined
  restarts: number
  /** `deps.now()` at the moment the instance last became ready; undefined until then. */
  readyAt: number | undefined
  /**
   * Bumped by `stop` and by every start. A start carries the generation it was issued
   * under and commits nothing once that generation is stale — this is what makes `stop`
   * CANCEL an in-flight start instead of merely forgetting it.
   */
  generation: number
  /** The single in-flight start (first start OR restart) for this key, if any. */
  inflight: Promise<Result<RunningPlugin, PluginError>> | undefined
}

/**
 * The contribution an ENABLED extension declares under `providerId`.
 *
 * The enabled filter is not a nicety: the registry reports everything installed, and a disabled
 * extension must never have its launch block reached. Contribution ids are unique across the
 * installed set (`@spectrum/extensions` rejects duplicates), so at most one match exists.
 */
const findContribution = (
  extensions: readonly LoadedExtension[],
  isEnabled: (extensionId: string) => boolean,
  providerId: string,
): ProviderContribution | undefined => {
  for (const extension of extensions) {
    if (!isEnabled(String(extension.manifest.id))) continue
    const match = extension.manifest.contributes.providers.find(
      (p) => p.id === providerId,
    )
    if (match !== undefined) return match
  }
  return undefined
}

const backoffFor = (attempt: number): number =>
  Math.min(RESTART_BACKOFF_MS * 2 ** (attempt - 1), MAX_RESTART_BACKOFF_MS)

/**
 * The `detail` on the `invalid-manifest` produced when a contribution that something asked to
 * RUN declares no `launch` block.
 *
 * Exported for the same reason as `FLOW_IN_FLIGHT_DETAIL`, and it is the same trap: `kind`
 * alone cannot separate this from a genuinely unparseable or newer-than-us step, which the
 * flow client also reports as `invalid-manifest`. A caller that turns errors into user-facing
 * copy has to tell "this manifest offers a setup flow but no server to run it" apart from
 * "this step needs a newer Spectrum" — and must not hand-copy the sentence to do it, or the
 * two halves drift apart on the next reword with nothing to catch it.
 *
 * Carries no contribution id, deliberately: an interpolated id would make exact matching
 * impossible, and `invalid-manifest.id` means the EXTENSION a manifest was read from, which
 * is a different id space from the contribution id this path has.
 */
export const NO_LAUNCH_BLOCK_DETAIL =
  "provider contribution declares no launch block"

/**
 * Supervises plugin-contributed provider servers as local child processes on loopback:
 * one process per `instanceKey`, restarted with a FRESH port and host token when it exits
 * unexpectedly, and stopped on demand.
 *
 * `ensureRunning` is deliberately idempotent and cheap on the already-running path — the
 * proxy calls it on every request, which is also how a restarted plugin's new port reaches
 * the provider factory.
 */
export const createProviderHost = (deps: ProviderHostDeps): ProviderHost => {
  const logger = deps.logger ?? createNoopLogger()
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const instances = new Map<string, Instance>()
  const byProvider = new Map<string, Set<string>>()

  const index = (providerId: string, instanceKey: string): void => {
    const keys = byProvider.get(providerId) ?? new Set<string>()
    keys.add(instanceKey)
    byProvider.set(providerId, keys)
  }

  const resolveLaunch = async (
    providerId: string,
  ): Promise<
    Result<{ launch: PluginLaunch; command: string }, PluginError>
  > => {
    const listed = await deps.registry.list()
    if (isErr(listed)) return listed

    const contribution = findContribution(
      listed.value,
      deps.isEnabled,
      providerId,
    )
    if (contribution === undefined)
      return err({ kind: "not-found", id: providerId })

    const launch = contribution.transport.launch
    if (launch === undefined)
      return err({ kind: "invalid-manifest", detail: NO_LAUNCH_BLOCK_DETAIL })

    // Guard BEFORE resolution: a relative path or a `..` segment is rejected outright,
    // never handed to the resolver. A manifest is untrusted input.
    const guarded = guardCommand(launch.command)
    if (isErr(guarded))
      return err({ kind: "invalid-manifest", detail: guarded.error.detail })
    const resolved = deps.resolver.resolve(launch.command)
    if (isErr(resolved))
      return err({ kind: "invalid-manifest", detail: resolved.error.detail })

    return ok({ launch, command: resolved.value })
  }

  const superseded = (): Result<RunningPlugin, PluginError> =>
    err({
      kind: "write-failed",
      detail: "start superseded by a stop or a newer start",
    })

  /**
   * True once a `stop` (or a newer start) has invalidated the generation this start owns.
   *
   * The two clauses guard different things and neither is redundant:
   * - `generation` guards IDENTITY — WHICH start owns this instance. After
   *   `stop` + `ensureRunning`, the status is `starting` again, so only the generation tells
   *   the superseded start that it no longer owns what it is about to write to.
   * - `status` guards STATE — whether any start is wanted at all. After a bare `stop` with no
   *   follow-up start, this is what stops the resuming start from resurrecting the instance.
   *   (`stop`'s own generation bump covers the same case; keeping both is deliberate, because
   *   losing BOTH leaks the orphan a stop was supposed to prevent.)
   */
  const stale = (instance: Instance, generation: number): boolean =>
    instance.generation !== generation || instance.status !== "starting"

  /**
   * Spawns one attempt and waits for the child to prove it is ours. Never restarts, and
   * never commits anything to an instance whose generation moved on underneath it.
   */
  const startOnce = async (
    instanceKey: string,
    providerId: string,
    secrets: Readonly<Record<string, string>>,
    generation: number,
  ): Promise<Result<RunningPlugin, PluginError>> => {
    const instance = instances.get(instanceKey)
    if (instance === undefined) return superseded()
    // Checked here as well as after the spawn so a stop landing during the restart backoff
    // costs nothing at all — no registry read, no port, no token, no process.
    if (stale(instance, generation)) return superseded()

    const found = await resolveLaunch(providerId)
    if (isErr(found)) {
      if (!stale(instance, generation)) instance.status = "failed"
      return found
    }
    const { launch, command } = found.value

    const port = await deps.allocator.allocate()
    if (isErr(port)) {
      if (!stale(instance, generation)) instance.status = "failed"
      return port
    }

    const hostToken = deps.tokenGen()
    const baseUrl = `http://${LOOPBACK}:${port.value}`
    // Secrets FIRST so a plugin cannot shadow a runtime token (notably `hostToken`)
    // by declaring a secret field with the same name.
    const values: Record<string, string> = {
      ...secrets,
      port: String(port.value),
      host: LOOPBACK,
      baseUrl,
      hostToken,
    }
    const args = renderPluginArgs(launch, values)
    const env = renderPluginEnv(launch, values)

    // Keys and TEMPLATES only. The env carries resolved secrets and the host token, and a
    // manifest may legitimately render a secret into an arg (`--key {{apiKey}}`), so the
    // rendered forms of both are unloggable. The resolved port is logged on ready instead.
    logger.info("spawning plugin provider", {
      providerId,
      command,
      args: launch.args,
      envKeys: Object.keys(env),
    })

    const spawned = deps.spawner.spawn(command, args, env, launch.cwd)
    if (isErr(spawned)) {
      logger.error("plugin provider spawn failed", {
        providerId,
        kind: spawned.error.kind,
        detail: spawned.error.detail,
      })
      if (!stale(instance, generation)) instance.status = "failed"
      return err({ kind: "write-failed", detail: spawned.error.detail })
    }

    // The commit point. A stop that landed while this start was suspended has already
    // bumped the generation and had no process to kill — so this start must kill the child
    // it just created and write NOTHING, or it leaks an orphan (and, if a newer start is
    // also in flight, a second live process on a second port under one instance key).
    if (stale(instance, generation)) {
      spawned.value.kill()
      return superseded()
    }

    instance.process = spawned.value
    instance.baseUrl = baseUrl
    instance.hostToken = hostToken
    instance.secrets = secrets

    // Attached BEFORE readiness so a child that dies mid-probe is still observed. The
    // handler only restarts an instance in the `running` state, so an exit during startup
    // or after `stop` is not treated as a crash.
    void spawned.value.exited
      .then((code: number) => {
        onExit(instanceKey, generation, code)
      })
      // `exited` is not documented to reject, but the interface promises nothing: a rejection
      // must not become an unhandled rejection that takes the app down.
      .catch((cause: unknown) => {
        logger.error("plugin provider exit watch failed", {
          providerId,
          detail: cause instanceof Error ? cause.message : String(cause),
        })
      })

    const ready = await waitForReady(
      { probe: deps.probe, sleep: deps.sleep },
      {
        url: `${baseUrl}${launch.healthPath}`,
        expectedToken: hostToken,
        timeoutMs: launch.readyTimeoutMs,
        now: deps.now,
      },
    )

    if (!ready) {
      logger.error("plugin provider never became ready", {
        providerId,
        port: port.value,
      })
      // Mark failed BEFORE killing: the kill resolves `exited`, and the handler must see a
      // non-running instance so it does not read the death as a crash worth restarting.
      if (!stale(instance, generation)) instance.status = "failed"
      spawned.value.kill()
      return err({
        kind: "write-failed",
        detail: `plugin provider "${providerId}" failed readiness`,
      })
    }

    if (stale(instance, generation)) {
      spawned.value.kill()
      return superseded()
    }

    instance.status = "running"
    instance.readyAt = deps.now()
    logger.info("plugin provider ready", { providerId, port: port.value })
    return ok({ baseUrl, pid: spawned.value.pid, hostToken })
  }

  const onExit = (
    instanceKey: string,
    generation: number,
    code: number,
  ): void => {
    const instance = instances.get(instanceKey)
    // Only a RUNNING instance can crash. `stopped` means we killed it, `failed` means the
    // start path already gave up, `starting` means the start path owns the outcome.
    if (instance === undefined || instance.status !== "running") return
    // A child from a superseded generation dying is not this instance's crash.
    if (instance.generation !== generation) return

    // The budget counts CONSECUTIVE failures: an instance that stayed ready long enough to
    // be considered healthy starts its next incident with a full budget.
    const uptime = deps.now() - (instance.readyAt ?? deps.now())
    if (uptime >= STABLE_UPTIME_MS) instance.restarts = 0

    if (instance.restarts >= maxRestarts) {
      instance.status = "failed"
      instance.process = undefined
      logger.error("plugin provider restart budget exhausted", {
        providerId: instance.providerId,
        restarts: instance.restarts,
        exitCode: code,
      })
      return
    }

    instance.restarts += 1
    const attempt = instance.restarts
    instance.status = "starting"
    instance.process = undefined
    instance.readyAt = undefined
    instance.generation += 1
    const restartGeneration = instance.generation
    logger.warn("restarting plugin provider", {
      providerId: instance.providerId,
      attempt,
      exitCode: code,
    })

    // Published as `inflight` so a concurrent ensureRunning awaits the restart instead of
    // spawning a second process, and so callers observe the NEW port when it completes.
    const slot: {
      promise: Promise<Result<RunningPlugin, PluginError>> | undefined
    } = { promise: undefined }
    slot.promise = (async (): Promise<Result<RunningPlugin, PluginError>> => {
      await deps.sleep(backoffFor(attempt))
      const started = await startOnce(
        instanceKey,
        instance.providerId,
        instance.secrets,
        restartGeneration,
      )
      const settled = instances.get(instanceKey)
      if (settled !== undefined && settled.inflight === slot.promise)
        settled.inflight = undefined
      return started
    })()
    instance.inflight = slot.promise
  }

  const ensureRunning = async (
    input: EnsureRunningInput,
  ): Promise<Result<RunningPlugin, PluginError>> => {
    const existing = instances.get(input.instanceKey)

    if (
      existing !== undefined &&
      existing.status === "running" &&
      existing.process !== undefined &&
      existing.baseUrl !== undefined
    ) {
      return ok({
        baseUrl: existing.baseUrl,
        pid: existing.process.pid,
        hostToken: existing.hostToken,
      })
    }

    if (existing?.inflight !== undefined) return existing.inflight

    const instance: Instance = existing ?? {
      status: "starting",
      providerId: input.providerId,
      secrets: input.secrets,
      process: undefined,
      baseUrl: undefined,
      hostToken: undefined,
      restarts: 0,
      readyAt: undefined,
      generation: 0,
      inflight: undefined,
    }
    instance.status = "starting"
    instance.secrets = input.secrets
    instance.generation += 1
    const generation = instance.generation
    instances.set(input.instanceKey, instance)
    index(input.providerId, input.instanceKey)

    // Registered synchronously, before the first await, so two callers racing on the same
    // key share one start and the process is spawned exactly once.
    const start = startOnce(
      input.instanceKey,
      input.providerId,
      input.secrets,
      generation,
    )
    instance.inflight = start
    try {
      return await start
    } finally {
      if (instance.inflight === start) instance.inflight = undefined
    }
  }

  const stop = async (instanceKey: string): Promise<void> => {
    const instance = instances.get(instanceKey)
    if (instance === undefined) return
    // Ordering is load-bearing: mark stopped FIRST, then kill. The kill makes `exited`
    // resolve, and the exit handler restarts only a `running` instance — marking after
    // the kill would race the handler and produce a zombie restart loop on shutdown.
    instance.status = "stopped"
    // Cancels any in-flight start: it will kill whatever it spawned and commit nothing,
    // rather than resurrecting this instance after stop returned.
    instance.generation += 1
    instance.inflight = undefined
    instance.restarts = 0
    instance.readyAt = undefined
    const process = instance.process
    instance.process = undefined
    instance.baseUrl = undefined
    instance.hostToken = undefined
    process?.kill()
  }

  return {
    ensureRunning,
    status: (instanceKey: string): PluginStatus =>
      instances.get(instanceKey)?.status ?? "stopped",
    stop,
    stopAllFor: async (providerId: string): Promise<void> => {
      for (const key of byProvider.get(providerId) ?? []) await stop(key)
    },
    stopAll: async (): Promise<void> => {
      for (const key of instances.keys()) await stop(key)
    },
    retainOnly: async (instanceKeys: ReadonlySet<string>): Promise<void> => {
      // Snapshot the keys first: `stop` awaits, and the map is mutated below.
      for (const key of [...instances.keys()]) {
        if (instanceKeys.has(key)) continue
        const providerId = instances.get(key)?.providerId
        await stop(key)
        // Forget it as well as stopping it. `stop` leaves a `stopped` record behind, which is
        // right for a key that may be asked for again; a retired configuration never will be,
        // so keeping it would trade a process leak for a map leak. Any start still in flight
        // was cancelled by `stop`'s generation bump and commits to an orphaned record.
        // NOTE: memory hygiene only — a deleted record and a `stopped` one are behaviourally
        // identical through this interface, so no test can pin this line.
        instances.delete(key)
        if (providerId !== undefined) {
          const keys = byProvider.get(providerId)
          keys?.delete(key)
          if (keys?.size === 0) byProvider.delete(providerId)
        }
      }
    },
  }
}
