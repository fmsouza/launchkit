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

- `createProviderHost(deps: { registry, isEnabled, resolver, spawner, allocator, probe, sleep,
  now, tokenGen, logger?, maxRestarts? }): ProviderHost` with
  `ensureRunning({ instanceKey, providerId, secrets })`, `status(instanceKey)`,
  `stop(instanceKey)`, `stopAllFor(providerId)`, `stopAll()`,
  `retainOnly(instanceKeys)` — stop and FORGET every instance the set does not name
- `PluginStatus = "stopped" | "starting" | "running" | "failed"`,
  `RunningPlugin = { baseUrl; pid; hostToken }`, `EnsureRunningInput`

### Setup flows
- `createFlowRunner(deps: { host, client, idGen, now, logger? }): FlowRunner` with
  `start`, `advance`, `takeCompletion`, `cancel`, `activeInstanceKeys()`,
  `abandon(keys, reason)` — drives one multi-step provider setup exchange over a DEDICATED
  supervised instance and enforces `FLOW_LIMITS` itself
- `flowInstanceKey(providerId, nonce)` / `flowContributionIdOf(key)` — the one definition of
  the `flow:<contribution id>:<nonce>` key format; `flowContributionIdOf` yields the provider
  CONTRIBUTION id (not an extension manifest id, and not a Spectrum `ProviderId`)
- `RunnerStep`, `FlowCompletion`, `FlowSessionId`, `FlowStartInput`, `FlowAdvanceInput`,
  `FlowAbandonReason`, `FlowRunner`, `FlowRunnerDeps`

## Local invariants
- `waitForReady` takes `probe`, `sleep`, and `now` as injected dependencies — no real
  timers, network, or clock in its own logic.
- The host token closes a real impersonation window: Spectrum allocates a loopback port by
  binding `:0`, releasing it, and passing the number to the child; between release and the
  child's bind, any local process can grab that port. `waitForReady` keeps polling on a
  mismatched token rather than accepting or failing immediately, because the real plugin may
  simply not have bound yet. A plugin with no launch block is user-run, has no token, and is
  not checked (`expectedToken === undefined`).
- SECURITY: `registry.list()` reports every extension ON DISK, enabled or not, so every lookup
  goes through the injected `isEnabled` (by MANIFEST id). Without it a disabled extension's
  `launch.command` is spawnable the moment anything asks for a contribution id it declares —
  with the resolved secrets of whichever provider record named that id in its environment.
  Contribution ids are unique across the installed set (`@spectrum/extensions` refuses
  duplicates), so at most one enabled extension can answer for a given contribution id.
- The host token is a credential — never logged.
- Process state is keyed by `instanceKey` (the proxy factory's provider cache key), not by
  contribution id: two Provider records can target one contribution with different API keys,
  and one process per contribution would make "whose secrets go in the env" ambiguous. A
  secondary `providerId → Set<instanceKey>` index backs `stopAllFor`.
- Exactly one in-flight start per instance key, registered synchronously before the first
  await — two racing `ensureRunning` calls spawn once. `ensureRunning` is idempotent and
  cheap once running; the proxy calls it per request, and that is how a restarted plugin's
  new port reaches the provider factory.
- Nothing here expires an instance on its own, so the composition root MUST sweep with
  `retainOnly` whenever the live config changes and on every extension refresh. The instance key
  is derived from the provider's config and secret refs, so editing one GUI field mints a new key
  and spawns a second child while the first stays `running` forever with the superseded secrets
  in its environment. `retainOnly` also DELETES the record, not just the process: a retired
  configuration is never asked for again, so keeping it would trade a process leak for a map leak.
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
- A flow runs on its OWN instance, never the serving one: in `context: "create"` there is no
  provider record yet, and a flow that hangs must not take a working provider down with it.
  The flow instance is stopped on EVERY terminal path — done, error, cancel, timeout,
  step-cap exhaustion, a failed or unparseable response.
- Caps are the RUNNER's, never the plugin's: 50 steps, a 10-minute total budget measured with
  the injected `now`, and an `await` step's `pollMs` replaced by `clampPollMs` before the step
  leaves the runner. A UI that trusted the plugin's number would poll at the plugin's rate.
- Two session ids, never interchanged: the runner mints the Spectrum-side `FlowSessionId` it
  hands its caller; the plugin mints its own, kept as `pluginSessionId` and echoed back to the
  plugin only.
- `done.secrets` never rides the returned step's path to the keychain — it is stashed and
  drained by exactly one `takeCompletion`, so a replayed IPC call cannot re-read it.
- `abandon` exists because `retainOnly` stops and forgets an instance with no callback and no
  reason code, and `status` cannot tell a swept instance from a crashed one: the composition
  root TELLS the runner which keys it is about to sweep, immediately before sweeping them, so
  a mid-flow "disable this extension" surfaces a named error step instead of a flow that hangs
  until its timeout.
- Flow logs carry `{ providerId, flowId, outcome }` and a step's `{ kind }` — never field
  values, `config`, `secrets`, the host token, the base URL's port, or the instance key.
- Logs `envKeys` (`Object.keys(env)`) and the UNRENDERED `launch.args` on spawn — never env
  values, never rendered args (a manifest may write `--key {{apiKey}}`), never the host
  token, never the instance key (itself a hash of the provider's secret refs). The resolved
  port is logged on ready, so nothing diagnostic is lost.
