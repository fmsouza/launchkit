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
- `createFlowRunner(deps: { host, client, idGen, now, setTimer, clearTimer, logger? }): FlowRunner`
  with `start`, `advance`, `takeCompletion`, `cancel`, `activeInstanceKeys()`,
  `abandon(keys, reason)`, `dispose()` — drives one multi-step provider setup exchange over a
  DEDICATED supervised instance and enforces `FLOW_LIMITS` itself. `dispose()` is teardown
  only: it releases every armed deadline (each live flow holds a ten-minute one-shot timer
  nothing else can reach) and stops no child, because its caller — `AppContext.shutdown` —
  stops the supervisor itself immediately after
- `flowInstanceKey(providerId, nonce)` / `flowContributionIdOf(key)` — the one definition of
  the `flow:<contribution id>:<nonce>` key format; `flowContributionIdOf` yields the provider
  CONTRIBUTION id (not an extension manifest id, and not a Spectrum `ProviderId`)
- `RunnerStep`, `FlowCompletion`, `FlowSessionId`, `FlowStartInput`, `FlowAdvanceInput`,
  `FlowAbandonReason`, `FlowTimerHandle`, `FlowRunner`, `FlowRunnerDeps` — `FlowTimerHandle`
  is `unknown`, so a composition root CAN name the type in its `setTimer`/`clearTimer`
  signatures but still needs one narrowing cast to hand the handle back to `clearTimeout`.
  Opaque on purpose: the runner never inspects a handle, only round-trips it, so nothing here
  should depend on whether the host's timer returns a number or a `Timeout` object
- `FetchLike` — the slice of `fetch` `createFetchFlowHttp` uses, injectable so the per-call
  abort deadline is testable (Bun's test runner does not deliver a fetch abort)
- `NO_LAUNCH_BLOCK_DETAIL` — the `detail` on the `invalid-manifest` returned when a
  contribution something asked to RUN declares no `launch` block. Exported for the same reason
  as `FLOW_IN_FLIGHT_DETAIL`: `@spectrum/extensions`'s flow client reports an unparseable or
  newer-than-us step with the same `kind`, so a caller writing user-facing copy must tell "this
  manifest offers a setup flow but no server to run it" apart from "this step needs a newer
  Spectrum". Carries NO contribution id — an interpolated id would defeat exact matching, and
  `invalid-manifest.id` means the EXTENSION a manifest was read from, a different id space
- `FLOW_IN_FLIGHT_DETAIL` — the `detail` on the `read-failed` that refuses a SECOND concurrent
  `advance`. Exported because that refusal alone is non-terminal while every other
  `read-failed` ends the flow, and `kind` cannot tell them apart: a caller that surfaces
  failures to a user must distinguish "you clicked twice" from "the extension died", and must
  not hand-copy the string to do it

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
- Nothing ties a `flow` action to a `launch` block at manifest-parse time, so a contribution
  that offers a setup flow with no launch block installs cleanly and fails only when the flow
  starts. That refusal is `invalid-manifest` + `NO_LAUNCH_BLOCK_DETAIL`; the detail is the only
  thing separating it from an unparseable step, and both halves import the constant.
- A flow runs on its OWN instance, never the serving one: in `context: "create"` there is no
  provider record yet, and a flow that hangs must not take a working provider down with it.
  The flow instance is stopped on EVERY terminal path — done, error, cancel, the deadline,
  the elapsed-budget check, step-cap exhaustion, a moved address, and a failed or unparseable
  response. The one exception is `abandon`, whose caller stops the instances itself (below).
- Caps are the RUNNER's, never the plugin's: 50 steps, a 10-minute total budget, and an
  `await` step's `pollMs` replaced by `clampPollMs` before the step leaves the runner. A UI
  that trusted the plugin's number would poll at the plugin's rate.
- The 10-minute budget is a DEADLINE, not only a check. `now` is read when a call arrives, so
  on its own it bounds nothing — a user who closes the setup window without cancelling would
  leave the child running forever. An injected `setTimer` arms the budget at `start` and ends
  the flow when it fires; every terminal path clears it. Each call is also given what remains
  of that budget as its `FlowHttp` `timeoutMs`, so one unanswered request cannot outlive it.
  Expiry RECORDS a user-facing message for the session, exactly as `abandon` does, because
  `end` then forgets the session and a forgotten session is indistinguishable from one that
  never existed: without it the only answer left is `not-found`, and the flow would be killed
  by the cap without the caller ever being told that is what happened.
- The recorded message is delivered to whichever call gets there first — the caller's next
  `advance`, or the one suspended INSIDE `advance` when the flow was killed. The suspended
  call is the one whose caller is actually listening; a UI that stops polling on a failure
  never makes the "next" call, so holding the reason back for it loses the reason.
- **A flow does not survive its child.** A crashed instance is restarted on a NEW port with a
  NEW host token, so the address captured at `start` is not a fact that stays true. Every step
  re-obtains it and ends the flow if the base URL, host token, or pid moved: the freed port is
  the impersonation window this package documents, and a form result is the credentials the
  user just typed. `status` is checked first so the re-check can never RESURRECT a child that
  was stopped or swept.
- One step in flight per session. A second concurrent `advance` is refused (not terminal — a
  double-click is not a reason to kill a flow), and the session identity is re-checked after
  every await: without that, a `done` resolving after a `cancel` would refill the completion
  the cancel had already drained.
- Two session ids, never interchanged: the runner mints the Spectrum-side `FlowSessionId` it
  hands its caller; the plugin mints its own, kept as `pluginSessionId` and echoed back to the
  plugin only.
- `done.secrets` never rides the returned step's path to the keychain — it is stashed and
  drained by exactly one `takeCompletion`, so a replayed IPC call cannot re-read it.
- `abandon` exists because `retainOnly` stops and forgets an instance with no callback and no
  reason code, and `status` cannot tell a swept instance from a crashed one: the composition
  root TELLS the runner which keys it is about to sweep, immediately before sweeping them, so
  a mid-flow "disable this extension" surfaces a named error step instead of a flow that hangs
  until its timeout. EVERY caller that kills a flow child owes the same pairing, not just the
  sweep — `ExtensionAdmin.remove` abandons before its `stopAll`/`stopAllFor` too. Abandon
  exactly what you are about to kill: narrower leaks a hung session, wider ends a flow whose
  child is still running.
- `FlowAbandonReason` is a closed union of ONE member covering three causes (disabled,
  uninstalled, contribution no longer installed), so `ABANDON_MESSAGE`'s copy says "disabled
  or removed". Splitting the reason would buy nothing the user can act on differently.
- Flow logs carry `{ providerId, flowId, outcome }` and a step's `{ kind }` — never field
  values, `config`, `secrets`, the host token, the base URL's port, or the instance key.
- Logs `envKeys` (`Object.keys(env)`) and the UNRENDERED `launch.args` on spawn — never env
  values, never rendered args (a manifest may write `--key {{apiKey}}`), never the host
  token, never the instance key (itself a hash of the provider's secret refs). The resolved
  port is logged on ready, so nothing diagnostic is lost.
