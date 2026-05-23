# LaunchKit — Agent rules

LaunchKit is a Bun + Electrobun desktop app (CLI + GUI) that proxies coding-agent harnesses to any LLM provider via the Vercel AI SDK. Monorepo: Bun workspaces + Turborepo.

## How to work here
- **Follow the build plan.** State lives in `build-plan/PROGRESS.md`; the protocol is `build-plan/EXECUTION.md`. Pick the next runnable task, implement it, update the ledger, commit. The full resume prompt is in `build-plan/README.md`.
- **Use your skills.** Always invoke `using-superpowers`, and `test-driven-development` on every task. Use `executing-plans`/`subagent-driven-development`, `verification-before-completion`, and `requesting-code-review` as the protocol describes.

## Non-negotiable rules
- **TypeScript only, strict.** No `any`. Every function has explicit input and output types. (`build-plan/01-conventions/typescript.md`)
- **Functional style.** Pure functions; small and single-purpose; effects (fs, net, spawn, sqlite, keychain, clock, random) behind injected adapter interfaces; `Result<T,E>` instead of throwing. (`functional-style.md`)
- **TDD always.** `bun test`, Jest API, tests named `it("does X when Y happens")`. RED → GREEN → REFACTOR. Test first, every time. (`tdd.md`)
- **Atomic design for the React UI only**; functional layering for backend packages. Dumb components never fetch — data enters at the page level. (`atomic-design.md`)
- **Security is optimal.** Secrets in the OS keychain (config stores only a reference); proxy on loopback + per-run key; zod-validate all external input; spawn with arg arrays; parameterized SQL; redact secrets in logs. (`security.md`)
- **Performance is optimal.** Stream the proxy (never buffer); cache provider instances; lazy-load `@ai-sdk/*`; fast CLI cold-start. (`performance.md`)
- **Respect package boundaries.** Import via `@launchkit/<pkg>` only; no deep imports; no cycles. (`build-plan/02-monorepo/boundaries.md`)

## Definition of Done (every task)
Test-first (RED observed) → implemented (GREEN) → refactored → `bun run typecheck && bun run lint && bun test` all green → `PROGRESS.md` updated with commit SHA → committed with the task ID. If you can't check every box, it's not done.

## Project skills
`launchkit-resume`, `launchkit-new-package`, `launchkit-add-provider`, `launchkit-add-harness`, `launchkit-atomic-component`. Invoke the relevant one.
