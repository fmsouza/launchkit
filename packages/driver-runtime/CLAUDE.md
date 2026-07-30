# @spectrum/driver-runtime

**Responsibility:** the reusable driver core. `createDriver(adapter)` wraps a per-harness `DriverAdapter`
into the locked synchronous `AgentDriver`/`AgentSession` seam — owning the sync↔async start bridge
(startup failure → `runner-finished:"errored"`), the approval bridge, runner-id minting + sub-agent
correlation, outbound command queueing (before the handle exists), and lifecycle/cleanup (`close`).

**Public API (barrel `src/index.ts`):** `AdapterHandle`/`AdapterCtx`/`DriverAdapter` (the adapter SPI);
`createDriver`. `createDriver` forwards `AgentSession.setMode` calls to `AdapterHandle.setMode` (queued
before the handle exists, like other outbound commands), and reads `DriverAdapter.supportedModes` to
populate the `runner-started.supportedModes` field emitted up-front on every run start.

**Depends on:** `@spectrum/agent-driver` (the seam + ports), `@spectrum/agent-events` (CanonicalEvent),
`@spectrum/utils` (Result, IdGen). NO harness SDKs — this package is PURE of harness specifics.

**Consumers:** `@spectrum/driver-acp` — the single ACP client driver, and the only `DriverAdapter`
implementation in the repo since the bespoke per-harness drivers were retired. A harness is added
by declaring an `acp` launch config on its `HarnessDefinition`, not by writing a new adapter.

**Effect owned:** none — pure logic. The async adapter start runs via an injected `scheduler`
(defaults to `queueMicrotask`; tests pass `(fn) => fn()`). `idGen` is injected (mints `rnr`/`apr`).

**Local rules:** `AgentSession.onEvent` is SINGLE-SUBSCRIBER (PtyHandle convention) — register once, fan
out inside the one callback; `ctx.emit` drops events when no subscriber is registered yet. `close()`
reaps the handle and is idempotent. The runtime knows only `CanonicalEvent` + the adapter SPI.
