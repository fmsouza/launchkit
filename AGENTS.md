# Spectrum — Agent rules

Spectrum is a Bun + Electrobun desktop app (CLI + GUI) that proxies coding-agent harnesses to any LLM provider via the Vercel AI SDK. Monorepo: Bun workspaces + Turborepo.

## How to work here
- **Follow the rules and the existing code.** Each package owns its own `AGENTS.md`; the root file is the global rulebook. For per-package local context (responsibility, public API, owned effects, local invariants) read `packages/<pkg>/AGENTS.md` or `apps/desktop/AGENTS.md`.
- **Use your skills.** Always invoke `using-superpowers`, and `test-driven-development` on every task. Use `executing-plans`/`subagent-driven-development`, `verification-before-completion`, and `requesting-code-review` as the protocol describes.
- **Use the project skills** in `.agents/skills/` for Spectrum-specific workflows (e.g. creating a new internal package).

## Non-negotiable rules
- **TypeScript only, strict.** No `any`. Every function has explicit input and output types.
- **Functional style.** Pure functions; small and single-purpose; effects (fs, net, spawn, sqlite, keychain, clock, random) behind injected adapter interfaces; `Result<T,E>` instead of throwing.
- **TDD always.** `bun test`, Jest API, tests named `it("does X when Y happens")`. RED → GREEN → REFACTOR. Test first, every time.
- **Atomic design for the React UI only**; functional layering for backend packages. Dumb components never fetch — data enters at the page level.
- **Security is optimal.** Secrets in the OS keychain (config stores only a reference); proxy on loopback + per-run key; zod-validate all external input; spawn with arg arrays; parameterized SQL; redact secrets in logs.
- **Performance is optimal.** Stream the proxy (never buffer); cache provider instances; lazy-load `@ai-sdk/*`; fast CLI cold-start.
- **Observability.** Log at effect boundaries, lifecycle transitions, and handler errors via the injected `Logger` (`@spectrum/logger`); never `console.*` in `src`; redact secrets before logging (never log raw secret values/refs); pure logic stays log-free. See `docs/01-conventions/logging.md`.
- **User feedback.** Surface user-facing failures via the notifications engine (toast; native when backgrounded) — never swallow a failed Result silently. See `docs/01-conventions/notifications.md`.
- **Respect package boundaries.** Import via `@spectrum/<pkg>` only; no deep imports; no cycles.

## Definition of Done (every task)
Test-first (RED observed) → implemented (GREEN) → refactored → `bun run typecheck && bun run lint && bun test` all green → committed with a Conventional-Commits message (and observability: boundaries/lifecycle/handler-errors log via the injected `Logger`, no `console.*` in `src`). If you can't check every box, it's not done.

## Package inventory (partial)
- `@spectrum/logger` — structured injectable logging (Logger + console/rotating-file sinks; depends on utils)
- `@spectrum/sessions` — session history (depends on db, types, utils)
- `@spectrum/projects` — project find-or-create + listing (depends on db, types, utils)
- `@spectrum/agent-events` — canonical event schemas + pure reducer (depends on types, utils; zero IO)
- `@spectrum/run-store` — append-only run-event persistence (depends on db, agent-events, types, utils)
- `@spectrum/agent-driver` — driver seam + run manager + socket protocol + FakeDriver (depends on agent-events, types, utils)
- `@spectrum/driver-runtime` — reusable driver core: createDriver(adapter) → AgentDriver (depends on agent-driver, agent-events, utils; no harness SDK)
- `@spectrum/driver-acp` — the ONE agent driver: an ACP client — createAcpDriver + pure mapAcpUpdate + pure negotiation helpers, over a real stdio JSON-RPC transport (depends on driver-runtime, agent-events, agent-driver, types, utils, zod, @agentclientprotocol/sdk). Drives every harness that declares an `acp` launch config (Claude, Codex, OpenCode, OpenClaw, Gemini, and any future ACP agent); adding one is a harness definition, not a package. See `docs/01-conventions/acp-architecture.md`.

## Project skills
`.agents/skills/spectrum-new-package` — creating a new internal package under `packages/`. Invoke it when it applies.
