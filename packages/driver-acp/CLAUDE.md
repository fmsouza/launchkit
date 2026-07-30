# @spectrum/driver-acp

**Responsibility:** the ACP (Agent Client Protocol) client — the SINGLE driver behind every harness that declares an `acp` launch config. A PURE `mapAcpUpdate` (one ACP `session/update` notification -> 0..n `CanonicalEvent`), four PURE negotiation helpers, and thin adapter glue: spawn the agent in ACP mode, run the `initialize` handshake, drive `session/new`/`session/load` -> `session/prompt` -> `session/update`, answer `session/request_permission` from `ctx.requestApproval` and `elicitation/create` from `ctx.requestQuestion`, and map `send`/`interrupt`/`setMode`/`close` onto `session/prompt`/`session/cancel`/`session/set_mode`/`session/close`. Wrapped by `@spectrum/driver-runtime`'s `createDriver` into an `AgentDriver`.

**Public API (barrel `src/index.ts`):** `createAcpDriver` (+ `AcpDriverDeps`); `mapAcpUpdate` (+ `AcpMapState`); the pure helpers `pickAcpModeId` / `supportedModesFrom` / `pickPermissionOptionId` / `toAcpPromptBlocks` / `elicitationToQuestion` / `answerToElicitationResponse` / `firstPropertyName`; the `AcpConnect`/`AcpClient`/`AcpConnection` port types plus the negotiated-shape types (`AcpInitializeResult`, `AcpSessionInfo`, `AcpConfigOption`, `AcpPromptCapabilities`, `AcpPermissionOutcome`, `AcpElicitationResponse`); and the zod schemas (`AcpSessionUpdateSchema`, `AcpStopReasonSchema`, `AcpPermissionRequestSchema`, `AcpElicitationSchema`).

**Depends on:** `@spectrum/driver-runtime`, `@spectrum/agent-events`, `@spectrum/agent-driver`, `@spectrum/types`, `@spectrum/utils`, `zod`, `@agentclientprotocol/sdk` (lazy-imported inside `real-connect.ts` only, so the CLI cold start never pays for it). NO harness-specific SDK.

**Effects owned:** the ACP agent process spawn + its stdio JSON-RPC stream — all inside `src/real-connect.ts`, behind the injected `AcpConnect` port; never reached around. Every other file is pure.

## Structure

| File | Role |
|---|---|
| `acp-client.ts` | Port types + zod schemas for the ACP wire subset. No logic. |
| `map-acp-update.ts` | PURE mapper: `session/update` -> `CanonicalEvent[]`. |
| `session-modes.ts` | PURE: Spectrum `PermissionMode` <-> agent-defined ACP mode ids. |
| `permission-outcome.ts` | PURE: `ApprovalDecision` -> the `optionId` to answer with. |
| `prompt-blocks.ts` | PURE: text + attachments -> ACP content blocks. |
| `elicitation.ts` | PURE: elicitation <-> question card. |
| `config-options.ts` | PURE: find the agent's model / reasoning-effort config option. |
| `real-connect.ts` | THE ONLY EFFECTFUL FILE: spawn + ndjson stdio + SDK client. |
| `adapter.ts` | Thin glue: handshake -> capabilities -> stream pump -> handle. |
| `driver.ts` | `createAcpDriver` factory. |

**Local rules:**
- Types are zod-first; every inbound payload is validated at the transport boundary (`real-connect.ts`) and a malformed notification is DROPPED, never thrown — one bad update must not kill a live run.
- `mapAcpUpdate` is pure and fixture-tested against a complete ACP v1 catalogue; the `sessionUpdate` union is TOTAL over v1 so a new kind is a type error, not a silent drop.
- The adapter is unit-tested with an injected fake `AcpConnect`; the transport is tested against a real SDK agent connected in-process (`clientApp.connect(agentApp)`), so no test spawns a process.
- Turn correlation: `send` fires `session/prompt` (fire-and-forget per `AdapterHandle.send(): void`) and the adapter awaits the promise internally, emitting `turn-finished` from the `stopReason` — `refusal`/`max_tokens`/`max_turn_requests` carry an error, `end_turn`/`cancelled` do not.
- Capabilities are NEGOTIATED per session, not declared statically: the adapter re-emits `runner-started` carrying `supportedModes` (from the agent's advertised mode ids) and `supportedAttachments` (from `initialize`'s `promptCapabilities`). The reducer merges `runner-started` field-by-field, which is what makes one shared driver instance work for every harness.
- SECURITY: the connect config's `env` carries the per-run proxy key. Nothing in this package logs.
- No `any`; no import of the proxy/UI/another driver.

## Verification status

The pure logic, the adapter, and the SDK-backed transport are unit-tested (the transport against an in-process SDK agent). Live-binary verification per harness is tracked in `src/acp-agent.integration.test.ts` (skipped when a binary is absent) and in tickets #119 (OpenClaw), #120 (OpenCode), #121 (Codex), #122 (Claude).
