import type {
  ExtensionRegistry,
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
}

export type ProviderHostDeps = {
  readonly registry: ExtensionRegistry
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

type Instance = {
  status: PluginStatus
  readonly providerId: string
  secrets: Readonly<Record<string, string>>
  process: SpawnedProcess | undefined
  baseUrl: string | undefined
  hostToken: string | undefined
  restarts: number
  /** The single in-flight start (first start OR restart) for this key, if any. */
  inflight: Promise<Result<RunningPlugin, PluginError>> | undefined
}

const findContribution = (
  extensions: readonly {
    readonly manifest: { readonly contributes: { providers: unknown } }
  }[],
  providerId: string,
): ProviderContribution | undefined => {
  for (const extension of extensions) {
    const providers = extension.manifest.contributes
      .providers as readonly ProviderContribution[]
    const match = providers.find((p) => p.id === providerId)
    if (match !== undefined) return match
  }
  return undefined
}

const backoffFor = (attempt: number): number =>
  Math.min(RESTART_BACKOFF_MS * 2 ** (attempt - 1), MAX_RESTART_BACKOFF_MS)

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

    const contribution = findContribution(listed.value, providerId)
    if (contribution === undefined)
      return err({ kind: "not-found", id: providerId })

    const launch = contribution.transport.launch
    if (launch === undefined)
      return err({
        kind: "invalid-manifest",
        detail: `provider contribution "${providerId}" declares no launch block`,
      })

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

  /** Spawns one attempt and waits for the child to prove it is ours. Never restarts. */
  const startOnce = async (
    instanceKey: string,
    providerId: string,
    secrets: Readonly<Record<string, string>>,
  ): Promise<Result<RunningPlugin, PluginError>> => {
    const instance = instances.get(instanceKey)
    const found = await resolveLaunch(providerId)
    if (isErr(found)) {
      if (instance !== undefined) instance.status = "failed"
      return found
    }
    const { launch, command } = found.value

    const port = await deps.allocator.allocate()
    if (isErr(port)) {
      if (instance !== undefined) instance.status = "failed"
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

    // envKeys only: the env carries resolved secrets AND the host token.
    logger.info("spawning plugin provider", {
      providerId,
      command,
      args,
      envKeys: Object.keys(env),
    })

    const spawned = deps.spawner.spawn(command, args, env, launch.cwd)
    if (isErr(spawned)) {
      logger.error("plugin provider spawn failed", {
        providerId,
        kind: spawned.error.kind,
        detail: spawned.error.detail,
      })
      if (instance !== undefined) instance.status = "failed"
      return err({ kind: "write-failed", detail: spawned.error.detail })
    }

    const current = instances.get(instanceKey)
    if (current === undefined) return err({ kind: "not-found", id: providerId })
    current.process = spawned.value
    current.baseUrl = baseUrl
    current.hostToken = hostToken
    current.secrets = secrets

    // Attached BEFORE readiness so a child that dies mid-probe is still observed. The
    // handler only restarts an instance in the `running` state, so an exit during startup
    // or after `stop` is not treated as a crash.
    void spawned.value.exited.then((code: number) => {
      onExit(instanceKey, code)
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
      current.status = "failed"
      spawned.value.kill()
      return err({
        kind: "write-failed",
        detail: `plugin provider "${providerId}" failed readiness`,
      })
    }

    current.status = "running"
    logger.info("plugin provider ready", { providerId, port: port.value })
    return ok({ baseUrl, pid: spawned.value.pid, hostToken })
  }

  const onExit = (instanceKey: string, code: number): void => {
    const instance = instances.get(instanceKey)
    // Only a RUNNING instance can crash. `stopped` means we killed it, `failed` means the
    // start path already gave up, `starting` means the start path owns the outcome.
    if (instance === undefined || instance.status !== "running") return

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
      inflight: undefined,
    }
    instance.status = "starting"
    instance.secrets = input.secrets
    instances.set(input.instanceKey, instance)
    index(input.providerId, input.instanceKey)

    // Registered synchronously, before the first await, so two callers racing on the same
    // key share one start and the process is spawned exactly once.
    const start = startOnce(input.instanceKey, input.providerId, input.secrets)
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
    instance.inflight = undefined
    instance.restarts = 0
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
  }
}
