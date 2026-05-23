import {
  type Config,
  createCachedConfigStore,
  createFileConfigStore,
  createInMemoryConfigFile,
  defaultConfig,
} from "@launchkit/config"
import type { LaunchParams } from "@launchkit/harnesses"
import type { RunningProxy } from "@launchkit/proxy"
import {
  createInMemoryKeychainBackend,
  createSecretStore,
} from "@launchkit/secrets"
import { createInMemoryDatabase, createSessionStore } from "@launchkit/sessions"
import type { HarnessDefinition } from "@launchkit/types"
import {
  type Result,
  createFixedClock,
  createSequentialIdGen,
  ok,
} from "@launchkit/utils"
import type { CliDeps, StartProxyDeps } from "./deps"
import { type MemoryWriter, createMemoryWriter } from "./writer"

/** A configurable, fully in-memory `CliDeps` for command tests. */
export type FakeDepsOverrides = {
  readonly out?: MemoryWriter
  readonly initialConfig?: Config
  readonly harnesses?: readonly HarnessDefinition[]
  readonly registryError?: unknown
  readonly isProxyRunning?: boolean
  readonly launchResult?: Result<{ readonly pid: number }, unknown>
  readonly launchSpy?: (params: LaunchParams) => void
  readonly proxyStartSpy?: (opts: StartProxyDeps) => void
  readonly proxyKey?: string
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

  const sessions = createSessionStore({
    db: createInMemoryDatabase(),
    clock: createFixedClock(new Date("2026-05-23T10:00:00.000Z")),
    idGen: createSequentialIdGen(),
  })
  sessions.init()

  const runningProxy: RunningProxy = {
    hostname: "127.0.0.1",
    port: 4000,
    stop: () => {},
  }

  return {
    config,
    secrets,
    sessions,
    out,
    registry: {
      list: async (): Promise<Result<readonly HarnessDefinition[], unknown>> =>
        over.registryError !== undefined
          ? { ok: false, error: over.registryError }
          : ok(over.harnesses ?? []),
    },
    launch: (
      params: LaunchParams,
    ): Result<{ readonly pid: number }, unknown> => {
      over.launchSpy?.(params)
      return over.launchResult ?? ok({ pid: 4321 })
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
  }
}
