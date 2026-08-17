import type { IpcClient } from "@spectrum/ipc"

/**
 * A partial set of method stubs -- each returns the same `Result` the real
 * client would. Methods left unstubbed default to a `handler-failed` Result so
 * a test that forgot to stub a call fails loudly rather than hanging.
 */
export type FakeClientStubs = Partial<{
  readonly [K in keyof IpcClient]: IpcClient[K]
}>

/** A fake client plus a per-method record of the params it was called with. */
export type FakeIpcClient = IpcClient & {
  readonly calls: { [K in keyof IpcClient]: Array<Parameters<IpcClient[K]>[0]> }
}

const METHOD_NAMES = [
  "getProviders",
  "getProviderCatalog",
  "addProvider",
  "updateProvider",
  "deleteProvider",
  "testProvider",
  "setProviderSecret",
  "getModels",
  "addModel",
  "updateModel",
  "deleteModel",
  "getHarnesses",
  "launchHarness",
  "getSessions",
  "getProxyStatus",
  "pickFolder",
  "openExternalUrl",
  "listProviderModels",
  "getSettings",
  "getTimeoutSettings",
  "updateTimeoutSettings",
  "getSessionNamingSettings",
  "updateSessionNamingSettings",
  "getProjects",
  "setCollapsedProjects",
  "getRunnerSocketUrl",
  "getRunEvents",
  "updateHarnessPrefs",
  "getUpdateState",
  "checkForUpdate",
  "startUpdateDownload",
  "applyUpdate",
  "dismissUpdate",
  "setUpdateChannel",
  "testProviderDraft",
  "listProviderModelsDraft",
  "pickUploads",
  "saveDroppedUploads",
  "readUploadThumbnail",
  "readUploadDataUrl",
  "openUploadExternal",
  "listExtensions",
  "installExtension",
  "setExtensionEnabled",
  "updateExtension",
  "removeExtension",
  "startProviderFlow",
  "advanceProviderFlow",
  "cancelProviderFlow",
] as const satisfies ReadonlyArray<keyof IpcClient>

/**
 * Build a fully-typed in-memory `IpcClient` from partial stubs. Used by every
 * hook/page test -- no Electrobun, no transport, deterministic. Records calls so
 * tests can assert (e.g.) that `setProviderSecret` received the typed value.
 */
export const createFakeIpcClient = (stubs: FakeClientStubs): FakeIpcClient => {
  // Build mutably, cast at the end — IpcClient keys are `readonly` so direct
  // assignment to a typed record would fail strict typecheck.
  const raw: Record<string, unknown> = {}
  const calls = {} as Record<string, unknown[]>

  for (const name of METHOD_NAMES) {
    calls[name] = []
    const stub = stubs[name]
    raw[name] = async (params: unknown): Promise<unknown> => {
      calls[name]?.push(params)
      if (stub === undefined) {
        return {
          ok: false,
          error: { kind: "handler-failed", detail: `unstubbed: ${name}` },
        }
      }
      return (stub as (p: unknown) => Promise<unknown>)(params)
    }
  }

  return Object.assign(raw as unknown as IpcClient, {
    calls,
  }) as unknown as FakeIpcClient
}
