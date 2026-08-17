# @spectrum/provider-host

Low-level primitives for hosting a plugin-contributed LLM provider as a Spectrum-spawned
local child process on loopback.

## Responsibility
Port allocation, host-token generation, readiness probing, and the supervisor that composes
them: spawning a plugin's provider server, proving it is ours, restarting it when it dies,
and stopping it on demand.

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

- `createProviderHost(deps: { registry, resolver, spawner, allocator, probe, sleep, now,
  tokenGen, logger?, maxRestarts? }): ProviderHost` with
  `ensureRunning({ instanceKey, providerId, secrets })`, `status(instanceKey)`,
  `stop(instanceKey)`, `stopAllFor(providerId)`, `stopAll()`
- `PluginStatus = "stopped" | "starting" | "running" | "failed"`,
  `RunningPlugin = { baseUrl; pid; hostToken }`, `EnsureRunningInput`

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
- Process state is keyed by `instanceKey` (the proxy factory's provider cache key), not by
  contribution id: two Provider records can target one contribution with different API keys,
  and one process per contribution would make "whose secrets go in the env" ambiguous. A
  secondary `providerId → Set<instanceKey>` index backs `stopAllFor`.
- Exactly one in-flight start per instance key, registered synchronously before the first
  await — two racing `ensureRunning` calls spawn once. `ensureRunning` is idempotent and
  cheap once running; the proxy calls it per request, and that is how a restarted plugin's
  new port reaches the provider factory.
- A restart mints a NEW port and a NEW host token — never reuses the dead instance's.
- Every start carries the `generation` it was issued under; `stop` and each new start bump it.
  A start whose generation went stale kills whatever it spawned and commits NOTHING. Without
  this, a `stop` landing while a start is suspended (mid `registry.list()`, mid restart
  backoff) leaves an orphan process that outlives Spectrum and flips the instance back to
  `running` after `stop` returned — and a following `ensureRunning` yields two live
  processes on two ports under one key.
- The `maxRestarts` budget counts CONSECUTIVE failures: an instance that stayed ready for
  `STABLE_UPTIME_MS` (60s, measured with the injected `now`) resets it. A lifetime counter
  would make a plugin that crashes monthly permanently `failed`; a naive reset on every
  successful start would make the budget unreachable, since a plugin that dies right after
  binding would restart forever.
- `stop` marks the instance `stopped` BEFORE killing. The kill resolves `exited`, and the
  exit handler restarts only a `running` instance; marking after the kill would race the
  handler into a zombie restart loop on shutdown. Same reason readiness failure marks
  `failed` before killing.
- Logs `envKeys` (`Object.keys(env)`) and the UNRENDERED `launch.args` on spawn — never env
  values, never rendered args (a manifest may write `--key {{apiKey}}`), never the host
  token, never the instance key (itself a hash of the provider's secret refs). The resolved
  port is logged on ready, so nothing diagnostic is lost.
