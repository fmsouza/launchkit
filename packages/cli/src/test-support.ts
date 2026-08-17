import {
  type Config,
  createCachedConfigStore,
  createFileConfigStore,
  createInMemoryConfigFile,
  defaultConfig,
} from "@spectrum/config"
import { createSqliteClient, runMigrations } from "@spectrum/db"
import type { LoadedExtension, PluginError } from "@spectrum/extensions"
import type { LaunchParams } from "@spectrum/harnesses"
import type { Logger } from "@spectrum/logger"
import { createProjectStore } from "@spectrum/projects"
import {
  type RunningProxy,
  type RuntimeState,
  createInMemoryRuntimeState,
} from "@spectrum/proxy"
import {
  createInMemoryKeychainBackend,
  createSecretStore,
} from "@spectrum/secrets"
import { createSessionStore } from "@spectrum/sessions"
import type { HarnessDefinition } from "@spectrum/types"
import {
  type Result,
  createFixedClock,
  createSequentialIdGen,
  err,
  ok,
} from "@spectrum/utils"
import type { CliDeps, StartProxyDeps } from "./deps"
import { type MemoryWriter, createMemoryWriter } from "./writer"

/** The launch result shape exposed by the CLI deps: pid + a promise of the harness exit code. */
type LaunchValue = { readonly pid: number; readonly exited: Promise<number> }

/** A configurable, fully in-memory `CliDeps` for command tests. */
export type FakeDepsOverrides = {
  readonly out?: MemoryWriter
  readonly initialConfig?: Config
  readonly harnesses?: readonly HarnessDefinition[]
  readonly registryError?: unknown
  readonly isProxyRunning?: boolean
  readonly launchResult?: Result<LaunchValue, unknown>
  readonly launchSpy?: (params: LaunchParams) => void
  /** The promise `launch().value.exited` resolves with (default: already-resolved `0`). */
  readonly launchExited?: Promise<number>
  readonly proxyStartSpy?: (opts: StartProxyDeps) => void
  /** Invoked when the `RunningProxy` returned by `proxy.start` is stopped. */
  readonly proxyStopSpy?: () => void
  readonly proxyKey?: string
  readonly runtime?: RuntimeState
  readonly logger?: Logger
}

export const makeFakeDeps = (over: FakeDepsOverrides = {}): CliDeps => {
  const out = over.out ?? createMemoryWriter()

  // A config store seeded with the override (write-through to the in-memory file).
  const file = createInMemoryConfigFile(
    JSON.stringify(over.initialConfig ?? defaultConfig()),
  )
  const config = createCachedConfigStore(createFileConfigStore({ file }))

  const secrets = createSecretStore({
    backend: createInMemoryKeychainBackend(),
    idGen: createSequentialIdGen(),
  })

  const opened = createSqliteClient(":memory:")
  if (!opened.ok) throw new Error(`db open failed: ${opened.error.detail}`)
  const client = opened.value
  const migrated = runMigrations(client)
  if (!migrated.ok) throw new Error(`migrate failed: ${migrated.error.detail}`)
  const sessions = createSessionStore({
    db: client,
    clock: createFixedClock(new Date("2026-05-23T10:00:00.000Z")),
    idGen: createSequentialIdGen(),
  })

  const projects = createProjectStore({
    db: client,
    clock: createFixedClock(new Date("2026-05-23T10:00:00.000Z")),
    idGen: createSequentialIdGen(),
  })

  const runningProxy: RunningProxy = {
    hostname: "127.0.0.1",
    port: 4000,
    stop: () => over.proxyStopSpy?.(),
  }

  const runtime = over.runtime ?? createInMemoryRuntimeState()

  return {
    config,
    secrets,
    sessions,
    projects,
    runtime,
    out,
    registry: {
      list: async (): Promise<Result<readonly HarnessDefinition[], unknown>> =>
        over.registryError !== undefined
          ? { ok: false, error: over.registryError }
          : ok(over.harnesses ?? []),
    },
    // No test in this package's suite (other than `plugin-command.test.ts`, which builds
    // its own harness) exercises the plugin command group — these are unused, no-op fakes
    // present only to satisfy `CliDeps`.
    extensions: {
      install: async (): Promise<Result<never, PluginError>> =>
        err({ kind: "write-failed", detail: "not implemented in fake" }),
      update: async (): Promise<Result<never, PluginError>> =>
        err({ kind: "write-failed", detail: "not implemented in fake" }),
      remove: async (): Promise<Result<void, PluginError>> => ok(undefined),
      setEnabled: async (): Promise<Result<void, PluginError>> => ok(undefined),
    },
    extensionRegistry: {
      list: async (): Promise<
        Result<readonly LoadedExtension[], PluginError>
      > => ok([]),
    },
    launch: (params: LaunchParams): Result<LaunchValue, unknown> => {
      over.launchSpy?.(params)
      return (
        over.launchResult ??
        ok({ pid: 4321, exited: over.launchExited ?? Promise.resolve(0) })
      )
    },
    proxy: {
      isRunning: async (): Promise<boolean> => over.isProxyRunning ?? false,
      start: (opts: StartProxyDeps): RunningProxy => {
        over.proxyStartSpy?.(opts)
        return runningProxy
      },
    },
    genProxyKey: (): string =>
      over.proxyKey ?? "test-proxy-key-0000000000000000000000",
    ...(over.logger ? { logger: over.logger } : {}),
  }
}
