# @spectrum/provider-host

Low-level primitives for hosting a plugin-contributed LLM provider as a Spectrum-spawned
local child process on loopback.

## Responsibility
Port allocation, host-token generation, and readiness probing — the building blocks the
Task 7 supervisor composes to launch and verify a plugin's provider server. Does not itself
launch or supervise a process.

## Public API
- `PortAllocator = { allocate(): Promise<Result<number, PluginError>> }`,
  `createLoopbackPortAllocator()` — binds `127.0.0.1:0`, reads the OS-assigned port, stops
  the server, returns the number
- `TokenGen = () => string`, `createCryptoTokenGen()` — `crypto.randomUUID()`
- `HOST_TOKEN_HEADER` — `"x-spectrum-host-token"`, the response header a launched plugin
  echoes to prove it is the process Spectrum spawned
- `HealthProbe = (url: string) => Promise<{ ok: boolean; token: string | undefined }>`,
  `createFetchHealthProbe()` — never throws; a connection refused during startup resolves
  to `{ ok: false, token: undefined }`
- `Sleep = (ms: number) => Promise<void>`
- `waitForReady(deps: { probe; sleep }, input: { url; expectedToken; timeoutMs; now }): Promise<boolean>`
  — polls with backoff (50 ms → 500 ms cap) until the probe reports `ok` and, when
  `expectedToken` is defined, a matching token, or the deadline passes

## Local invariants
- `waitForReady` takes `probe`, `sleep`, and `now` as injected dependencies — no real
  timers, network, or clock in its own logic.
- The host token closes a real impersonation window: Spectrum allocates a loopback port by
  binding `:0`, releasing it, and passing the number to the child; between release and the
  child's bind, any local process can grab that port. `waitForReady` keeps polling on a
  mismatched token rather than accepting or failing immediately, because the real plugin may
  simply not have bound yet. A plugin with no launch block is user-run, has no token, and is
  not checked (`expectedToken === undefined`).
- The host token is a credential — never logged.
