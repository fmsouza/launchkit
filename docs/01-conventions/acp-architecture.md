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

ACP is the open standard (JSON-RPC 2.0 over stdio) for editor↔coding-agent communication, now at v1 stable. Every agent Spectrum supports ships an ACP server. The migration replaced four bespoke drivers with one shared `@spectrum/driver-acp` package.

## The ACP driver

`@spectrum/driver-acp` is a single `DriverAdapter` over the `@agentclientprotocol/sdk` TypeScript client. All of the logic is pure; exactly one file performs effects.

| File | Role |
|---|---|
| `acp-client.ts` | Port types + zod schemas for the ACP wire subset. No logic. |
| `map-acp-update.ts` | PURE mapper: one `session/update` → 0..n `CanonicalEvent`. |
| `session-modes.ts` | PURE: Spectrum `PermissionMode` ↔ agent-defined ACP mode ids. |
| `permission-outcome.ts` | PURE: `ApprovalDecision` → the `optionId` to answer with. |
| `prompt-blocks.ts` | PURE: text + attachments → ACP content blocks. |
| `elicitation.ts` | PURE: elicitation ↔ question card. |
| `config-options.ts` | PURE: find the agent's model / effort / mode config option. |
| `real-connect.ts` | The ONLY effectful file: spawn + ndjson stdio + SDK client. |
| `adapter.ts` | Thin glue: handshake → capabilities → stream pump → handle. |
| `driver.ts` | `createAcpDriver` factory. |

The transport is tested against a real SDK **agent** connected in-process (`clientApp.connect(agentApp)`), so no unit test spawns a process. `acp-agent.integration.test.ts` runs the real spawn + handshake against whichever agent binaries are installed, skipping the rest.

## ACP ↔ CanonicalEvent mapping

The v1 `sessionUpdate` union is modeled in full, so a new kind is a type error rather than a silent drop.

| ACP `session/update` kind | `CanonicalEvent` |
|---|---|
| `agent_message_chunk` | `text-delta` (role: assistant, keyed by messageId) |
| `agent_thought_chunk` | `reasoning-delta` (keyed by messageId) |
| `tool_call` | `tool-call-started` (dedup by toolCallId) |
| `tool_call_update` (in_progress) | `tool-output-delta` |
| `tool_call_update` (completed) | `tool-call-finished` (status: ok) |
| `tool_call_update` (failed) | `tool-call-finished` (status: error) |
| `plan`, `plan_update` | `plan-update` (REPLACE semantics; one stable planId per runner) |
| `usage_update` | `usage` (with contextUsed/contextSize) |
| `current_mode_update` | `annotation` (kind: mode-change) |
| `user_message_chunk` | — (the runtime already echoed the user's turn) |
| `available_commands_update`, `session_info_update`, `config_option_update`, `plan_removed` | — (no Spectrum surface yet) |
| unknown | `[]` (defensive) |

## Turn correlation

Spectrum's `AgentSession.send` is fire-and-forget (`void`); ACP's `session/prompt` is request/response (returns `{ stopReason }`). The adapter reconciles this: `handle.send` fires `session/prompt` without awaiting; internally the adapter holds the promise and emits `turn-finished` on resolution. `refusal`, `max_tokens` and `max_turn_requests` carry an error detail; `end_turn` and `cancelled` are clean endings.

## Capability negotiation

One driver instance serves every harness, so capabilities cannot be static. The adapter re-emits `runner-started` after the handshake carrying what THIS agent negotiated — the reducer merges `runner-started` field-by-field (`event.x ?? existing?.x`):

- **Attachments** ← `initialize`'s `promptCapabilities` (`image`, `embeddedContext`). Attachment kinds the agent did not advertise are dropped rather than sent: an unsupported content block fails the whole turn.
- **Modes** ← `session/new`'s `modes.availableModes`, **or** a `category: "mode"` config option. Agents use both surfaces; OpenCode uses only the latter, so reading only `modes` reports no modes at all.
- **Model / thinking effort** ← `session/set_config_option`, found by the agent's own `category` (`"model"`, `"thought_level"`).

Mode ids are agent-defined strings, mapped by best-match. Observed live:

| Agent | Mode ids |
|---|---|
| Claude | `auto`, `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| Codex | `read-only`, `agent`, `agent-full-access` |
| OpenCode | `build`, `plan` (as a config option, not `modes`) |

**The run's permission mode is applied at session start**, defaulting to `manual`. This is a safety requirement, not a nicety: `claude-agent-acp` opens sessions in `bypassPermissions`, which auto-approves every tool call and never consults the permission callback — inheriting it would silently disable Spectrum's approval cards.

## Launching an ACP agent

| Harness | ACP entry point | Install |
|---|---|---|
| OpenCode | `opencode acp` (native) | — |
| OpenClaw | `openclaw acp` (native) | — |
| Gemini CLI | `gemini --acp` (native) | `npm i -g @google/gemini-cli` |
| Claude Code | `claude-agent-acp` (separate binary) | `npm i -g @agentclientprotocol/claude-agent-acp` |
| Codex | `codex-acp` (separate binary) | `npm i -g @agentclientprotocol/codex-acp` |

Neither `claude --acp` nor `codex acp` exists — both are adapter binaries, which is why `HarnessDefinition.acp` carries an optional `command` override. The older `@zed-industries/*` packages are deprecated; `@zed-industries/claude-code-acp` in particular fails at `session/new`.

## How to add a new ACP-compatible agent

Config only — no new driver package, and no composition-root edit:

1. Add a harness definition in `packages/harnesses/src/builtin/<agent>.ts` with an `acp` field.
2. Add it to `builtinHarnesses` in `packages/harnesses/src/builtin/index.ts`.

The composition root derives its ACP harness set from the definitions (a harness is ACP-routed iff it declares an `acp` config), so the driver, the registry and the launch path pick it up automatically. `packages/harnesses/src/builtin/gemini.ts` is the worked example.

**Verify the flag against the real binary before shipping it.** Every ACP flag in this repo was wrong on first writing.

See the ACP agent registry: https://agentclientprotocol.com/get-started/agents

## Known issue: Claude Code ignores the proxy token

**A proxied Claude session fails to authenticate against the Spectrum proxy.** This is NOT an ACP
issue — the native spawn path fails identically — but it is the one thing standing between a Claude
session and a Spectrum-routed model.

Claude Code 2.1.220 sends its cached subscription OAuth token instead of `ANTHROPIC_AUTH_TOKEN`.
Captured against a header-logging endpoint with `ANTHROPIC_AUTH_TOKEN` set to a known value:

```
authorization: "Bearer sk-an…(len 115)"        <- an sk-ant-oat OAuth token, not ours
anthropic-beta: …,oauth-2025-04-20,…
user-agent:     claude-cli/2.1.220
```

The harness definition's comment asserts the opposite precedence, which was presumably true when it
was written. Setting `ANTHROPIC_API_KEY` as well does not change it. The proxy is not at fault: it
accepts both the master key and a session-encoded key, over `Authorization: Bearer` and `x-api-key`,
returning 200 and a real stream.

**The one verified lever** is Claude Code's simple mode — `CLAUDE_CODE_SIMPLE=1` (what `--bare`
sets), documented as *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings
(OAuth and keychain are never read)"*. With it set, Claude Code sends Spectrum's token. It is not
enabled here because simple mode also disables **CLAUDE.md auto-discovery**, hooks, LSP, plugin
sync and auto-memory — a serious downgrade for a coding session, and a trade-off for the user to
make rather than one to bake in silently.

Adding `CLAUDE_CODE_SIMPLE: "1"` to `claude`'s `envTemplate` would scope it correctly if that
trade-off is accepted: `envTemplate` renders only for proxied routes, so a "default" (direct)
session would stay fully featured.

## Accepted regressions

- **Sub-agent trees flatten.** ACP v1's `session/update` has no child-session concept, so Claude's `Agent`/`Task` calls render as tool calls on the root runner rather than child runners.
- **Mid-turn steering (Codex `turn/steer`) is gone.** ACP v1 is one prompt → one `stopReason`. (`claude-agent-acp` advertises `_meta.steering.supported`, so this may be reachable later via `_meta`.)
- **Codex sandbox granularity is coarsened** to the three modes Codex advertises (`read-only`, `agent`, `agent-full-access`).
- **Model switching depends on the agent.** It works where the agent advertises a `category: "model"` config option (OpenCode, Codex, Claude). Spectrum's own route ids will not match an agent's model list, so switching the Spectrum route still takes effect through the proxy env on the next session rather than mid-session.
- **Codex resume is unresolved.** `codex-acp` advertises `loadSession: true` and a `resume` session
  capability, but rejected a `session/load` of a live session with an internal error. OpenCode and
  Claude both accept it. Needs a follow-up against the adapter's own semantics (it may want
  `session/resume` rather than `session/load`).
- **User-JSON harnesses declaring `acp` are not auto-registered.** The driver registry is built once at startup while the harness registry hot-reloads from disk. Builtins only.

Reasoning effort is **not** a regression: both Claude (`thought_level`) and Codex (`reasoning_effort`) expose it as a session config option, and `setThinkingEffort` drives it.

## References

- ACP spec: https://agentclientprotocol.com/protocol/v1/overview
- ACP TypeScript SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
- ACP agent registry: https://agentclientprotocol.com/get-started/agents
- Migration epic: https://github.com/fmsouza/spectrum/issues/114
