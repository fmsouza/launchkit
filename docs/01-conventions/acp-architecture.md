# ACP Architecture

> How Spectrum communicates with coding agents via the Agent Client Protocol (ACP).

## Why ACP

Spectrum previously had four bespoke, harness-native driver packages — each with a hand-written transport, handshake, streaming pump, and pure mapper:

| Harness | Old transport | Old driver |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` `query()` | `@spectrum/driver-claude` |
| Codex | JSON-RPC 2.0 over stdio to `codex app-server` (~60 generated binding files) | `@spectrum/driver-codex` |
| OpenCode | HTTP REST + Server-Sent Events to `opencode serve` | `@spectrum/driver-opencode` |
| OpenClaw | Documented Gateway WebSocket (UNVERIFIED — throwing stub) | `@spectrum/driver-openclaw` |

This bespoke-per-harness approach had real costs: N drivers to maintain, harness churn breaking drivers (Codex binding drift tripwire), divergent feature semantics, and ecosystem isolation.

ACP (Agent Client Protocol) is the Zed-led open standard (JSON-RPC 2.0 over stdio) for editor↔coding-agent communication, now at v1 stable. Every agent Spectrum supports ships an ACP server. The migration replaced four bespoke drivers with one shared `@spectrum/driver-acp` package.

## The ACP driver

`@spectrum/driver-acp` is a single `DriverAdapter` that wraps the `@agentclientprotocol/sdk` TypeScript client:

- **`acp-client.ts`** — `AcpConnect`/`AcpClient`/`AcpConnection` port interfaces (injected transport) + zod schemas for the ACP `session/update` discriminated union (7 update kinds: `agent_message_chunk`, `thought`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `mode`).
- **`map-acp-update.ts`** — the pure mapper (`mapAcpUpdate(notif, state) -> CanonicalEvent[]`). Fixture-tested, no IO, deterministic.
- **`adapter.ts`** — `createAcpAdapter(deps): DriverAdapter`. The ACP client adapter: `initialize` handshake, `session/new`/`session/load`, `session/prompt` (fire-and-forget per the `AdapterHandle.send(): void` contract; the adapter awaits internally and emits `turn-finished` on `stopReason`), `session/update` streaming -> `mapAcpUpdate` -> `ctx.emit`, `session/request_permission` -> `ctx.requestApproval` bridge, `elicitation/create` -> `ctx.requestQuestion` bridge, `session/cancel` for interrupt, `session/set_mode` for mode switch, `session/close` for close.
- **`driver.ts`** — `createAcpDriver(deps): AgentDriver` factory wrapping `@spectrum/driver-runtime`'s `createDriver`.

## ACP ↔ CanonicalEvent mapping

| ACP `session/update` kind | `CanonicalEvent` |
|---|---|
| `agent_message_chunk` | `text-delta` (role: assistant, keyed by messageId) |
| `thought` | `reasoning-delta` (keyed by messageId) |
| `tool_call` (pending) | `tool-call-started` (dedup by toolCallId) |
| `tool_call_update` (in_progress) | `tool-output-delta` |
| `tool_call_update` (completed) | `tool-call-finished` (status: ok) |
| `tool_call_update` (failed) | `tool-call-finished` (status: error) |
| `plan` | `plan-update` (replace semantics keyed by planId) |
| `usage_update` | `usage` (with contextUsed/contextSize) |
| `mode` | `annotation` (kind: mode-change) |
| unknown | `[]` (defensive) |

## Turn correlation

Spectrum's `AgentSession.send` is fire-and-forget (`void`); ACP's `session/prompt` is request/response (returns `{ stopReason }`). The adapter reconciles this: `handle.send` fires `client.sessionPrompt(...)` without awaiting; internally the adapter holds the prompt promise and emits `turn-finished` on resolution. This preserves Spectrum's push-streamed UX while honoring ACP's request/response turn model.

## How to add a new ACP-compatible agent

Adding a new ACP agent is a config-only entry — no new driver package needed:

1. Add a harness definition in `packages/harnesses/src/builtin/<agent>.ts` with an `acp: { args: [...], native: true }` field.
2. Add the harness to `packages/harnesses/src/builtin/index.ts` `builtinHarnesses`.
3. Add the harness id to `ACP_HARNESSES` in `packages/runtime-core/src/create-app-context.ts`.

The ACP driver handles the rest: spawn, handshake, streaming, approvals, elicitation, interrupt, resume.

See the ACP agent registry: https://agentclientprotocol.com/get-started/agents

## Accepted regressions

Per-harness feature drops documented during the migration:

**Codex:**
- Mid-turn steering (`turn/steer`) — ACP v1 has no equivalent.
- Sandbox policy granularity — coarsened to ACP modes.
- Reasoning effort tiers — pending ACP `model_config` verification.

**Claude:**
- Streaming-input mode — ACP's `session/prompt` is request/response, not push-stream.
- `refusal_fallback_prompt` — may be dropped if the Zed adapter shim doesn't map it.
- Adaptive thinking `effort` — may become a no-op if not exposed via ACP `model_config`.

## References

- ACP spec: https://agentclientprotocol.com/protocol/v1/overview
- ACP TypeScript SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
- ACP agent registry: https://agentclientprotocol.com/get-started/agents
- Migration epic: https://github.com/fmsouza/spectrum/issues/114