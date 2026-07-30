# @spectrum/driver-acp

**Responsibility:** the ACP (Agent Client Protocol) client adapter. A PURE `mapAcpUpdate` (one ACP `session/update` notification -> 0..n `CanonicalEvent`, given a small mapping state) + thin adapter glue: spawn the agent in ACP mode, run the `initialize` handshake, drive `session/new`/`session/load` -> `session/prompt` -> `session/update` stream, bridge `session/request_permission` -> `ctx.requestApproval` and `elicitation/create` -> `ctx.requestQuestion`, and map `send`/`interrupt`/`setMode`/`close` onto `session/prompt`/`session/cancel`/`session/set_mode`/`session/close`. Wrapped by `@spectrum/driver-runtime`'s `createDriver` into an `AgentDriver`.

**Public API (barrel `src/index.ts`):** `createAcpDriver` (+ type `AcpDriverDeps`), `mapAcpUpdate` (+ type `AcpMapState`), the `AcpConnect`/`AcpClient`/`AcpConnection` port types, the `AcpSessionUpdateSchema` zod schema + inferred types, `AcpStopReasonSchema`, `AcpPermissionRequestSchema`, `AcpElicitationSchema`.

**Depends on:** `@spectrum/driver-runtime`, `@spectrum/agent-events`, `@spectrum/agent-driver`, `@spectrum/types`, `@spectrum/utils`, `zod`. Does NOT depend on any harness-specific SDK — `@agentclientprotocol/sdk` is lazy-loaded only inside `realAcpConnect` (the production transport, which throws until wired per tickets #119-#122).

**Effects owned:** the ACP agent process spawn — behind the injected `AcpConnect` port; never reached around. No direct fs/net/spawn in this package's logic.

**Local rules:** types are zod-first; `mapAcpUpdate` is pure + fully fixture-tested; the adapter is unit-tested with an injected fake `AcpConnect` (no real agent spawn); no `any`; no import of the proxy/UI/other drivers. The turn correlation pattern: `send` fires `session/prompt` (fire-and-forget per the `AdapterHandle.send(): void` contract); the adapter awaits the prompt promise internally and emits `turn-finished` on the `stopReason` response.

## Verification status

The pure mapper and adapter logic are fully unit-tested. The real transport (`realAcpConnect`) throws until `@agentclientprotocol/sdk` is wired — that integration is verified per-harness in tickets #119 (OpenClaw), #120 (OpenCode), #121 (Codex), #122 (Claude).