import type { IpcClient } from "@launchkit/ipc"

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
  "getProviders", "addProvider", "updateProvider", "deleteProvider", "testProvider", "setProviderSecret",
  "getAliases", "addAlias", "updateAlias", "deleteAlias",
  "getHarnesses", "addHarness", "updateHarness", "deleteHarness", "launchHarness",
  "getSessions", "getProxyStatus",
] as const satisfies ReadonlyArray<keyof IpcClient>

/**
 * Build a fully-typed in-memory `IpcClient` from partial stubs. Used by every
 * hook/page test -- no Electrobun, no transport, deterministic. Records calls so
 * tests can assert (e.g.) that `setProviderSecret` received the typed value.
 */
export const createFakeIpcClient = (stubs: FakeClientStubs): FakeIpcClient => {
  const calls = {} as { [K in keyof IpcClient]: Array<Parameters<IpcClient[K]>[0]> }
  const client = {} as Record<keyof IpcClient, (params: unknown) => Promise<unknown>>

  for (const name of METHOD_NAMES) {
    calls[name] = []
    const stub = stubs[name] as ((params: unknown) => Promise<unknown>) | undefined
    client[name] = async (params: unknown): Promise<unknown> => {
      calls[name].push(params as never)
      if (stub === undefined) {
        return { ok: false, error: { kind: "handler-failed", detail: `unstubbed: ${name}` } }
      }
      return stub(params)
    }
  }

  return Object.assign(client as unknown as IpcClient, { calls }) as FakeIpcClient
}
