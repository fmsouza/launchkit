# LaunchKit — Build Plan Design Spec

**Date:** 2026-05-23
**Status:** Approved (design phase)
**Author:** brainstorming session
**Source architecture:** [`launchkit-architecture.md`](../../../launchkit-architecture.md)

---

## 1. Purpose

This spec defines the **planning system** for building LaunchKit from scratch. The deliverable of this work is a `build-plan/` folder — a complete, self-contained set of plans, conventions, CLAUDE rules, project skills, and a progress ledger — designed so that **any agent can be handed a single prompt at any time, read the current state, and continue implementation from exactly where the last agent stopped, until the application is fully built.**

This document is the *design* (the "what and why"). The detailed, per-package, task-by-task TDD plans (the "how, step by step") are produced in the next phase by the `writing-plans` skill and live in `build-plan/04-plans/`.

> **Scope boundary.** This work produces *plans only*. It does **not** scaffold the application, run `electrobun init`, or install dependencies. Those are the first tasks the implementing agents execute, driven by the plans. The only thing initialized here is a git repository to version-control the plans themselves.

---

## 2. Locked decisions

These were settled during brainstorming and are non-negotiable inputs to every downstream plan.

| Topic | Decision | Rationale |
|---|---|---|
| **Deliverable** | Planning folder only; agents scaffold the repo as task #1 | Matches "a folder with all the plans"; keeps the plan fully resumable from a clean slate |
| **Runtime** | Bun + Electrobun | From the architecture doc |
| **Language** | TypeScript only, strict, all functions have explicit input/output types | User requirement |
| **Style** | Functional: pure functions, `Result<T,E>` over throwing, effects isolated behind injected adapters; "dumb" functions composed into features | User requirement |
| **Test runner** | `bun test` using the Jest-compatible API (`describe`/`it`/`expect`) | Native to Bun/Electrobun, zero-config, fast, reads identically to Jest |
| **Test naming** | `it("does X when Y happens")` | User requirement |
| **GUI** | React in the WebKit webview | User choice |
| **Atomic design** | Strict atomic design for the React UI; functional layering (primitives → composites → features) for backend packages | User choice |
| **Repo shape** | Monorepo: Bun workspaces + Turborepo, internal apps + packages split by domain | User requirement |
| **Lint/format** | Biome (single fast tool, Bun-friendly) | Performance + ecosystem fit |
| **Validation** | Zod for all runtime validation; types inferred from schemas where possible | Security + typed signatures in one |
| **Secrets** | macOS Keychain via a `secrets` package; `config.json` stores only a keychain reference | "Security must be optimal" overrides the architecture doc's "plaintext for now" |
| **Execution model** | Approach A: progress ledger + per-package TDD plans + canonical resume prompt | Domain separation + sequential & parallel execution + resume-from-anywhere |

---

## 3. Deliverable: the `build-plan/` folder

Created at the repository root for visibility.

```
build-plan/
├── README.md                 # Entry point. Contains the canonical, paste-able RESUME PROMPT.
├── 00-overview.md            # Vision, architecture recap, the locked decisions table.
├── 01-conventions/
│   ├── typescript.md         # tsconfig strategy, strictness flags, no-any, typed signatures
│   ├── functional-style.md   # pure functions, Result<T,E>, effect isolation, composition
│   ├── tdd.md                # bun test, Jest API, "it ... when ..." naming, RED→GREEN→REFACTOR
│   ├── atomic-design.md      # atoms→molecules→organisms→templates→pages rules for the UI
│   ├── security.md           # the full security checklist (see §7)
│   ├── performance.md        # the full performance checklist (see §8)
│   └── git.md                # branch/commit conventions, task-ID references, definition-of-done
├── 02-monorepo/
│   ├── layout.md             # apps/ + packages/ tree, what lives where
│   ├── boundaries.md         # package public APIs, allowed import edges, the dependency DAG
│   └── tooling.md            # Bun workspaces, Turborepo pipeline, Biome, shared tsconfig
├── 03-claude-config/
│   ├── root-claude-md.md     # exact content for the root CLAUDE.md
│   ├── package-claude-md.md  # template + per-package CLAUDE.md content
│   └── skills.md             # specs for each project skill to create (see §6)
├── 04-plans/                 # produced next by writing-plans — one ordered plan per package/phase
│   ├── 00-phase0-bootstrap.md
│   ├── 01-types.md
│   ├── 02-utils.md
│   ├── 03-secrets.md
│   ├── 04-ipc.md
│   ├── 05-config.md
│   ├── 06-sessions.md
│   ├── 07-proxy.md
│   ├── 08-harnesses.md
│   ├── 09-cli.md
│   ├── 10-ui.md
│   ├── 11-desktop-shell.md
│   ├── 12-gui-pages.md
│   └── 13-tray-and-polish.md
├── PROGRESS.md               # the ledger — every task, status, deps, completing commit
└── EXECUTION.md              # the orchestration protocol + definition-of-done
```

---

## 4. Monorepo architecture

**One app, many packages.** "One binary, two modes" means there is a single Electrobun application; everything else is a domain package it composes.

```
launchkit/
├── package.json              # workspace root: workspaces, turbo, scripts
├── turbo.json                # build/test/lint/typecheck pipeline + caching
├── biome.json                # lint + format
├── bunfig.toml               # bun test preload (happy-dom registrator), config
├── tsconfig.base.json        # strict base config extended by every package
│
├── apps/
│   └── desktop/              # the single Electrobun binary (CLI + GUI modes)
│       ├── electrobun.config.ts
│       ├── src/
│       │   ├── main.ts       # dual-mode entry (detects CLI vs GUI)
│       │   └── gui/
│       │       ├── window.ts # BrowserWindow + app menu
│       │       ├── tray.ts   # system tray + quick-launch submenu
│       │       └── ipc/handlers.ts  # binds the IPC contract to subsystems
│       └── views/main/       # React app: index.html, app.tsx, pages composed from @launchkit/ui
│
├── packages/
│   ├── types/                # @launchkit/types — Provider, ModelAlias, HarnessDefinition, Session + zod schemas
│   ├── utils/                # @launchkit/utils — Result, pipe/flow, env-template renderer, redaction, id gen
│   ├── secrets/              # @launchkit/secrets — keychain-backed secret storage
│   ├── ipc/                  # @launchkit/ipc — the typed IPC contract + (de)serialization
│   ├── ui/                   # @launchkit/ui — React atomic design system (atoms→organisms+templates)
│   ├── config/               # @launchkit/config — config.json store, defaults, migrations
│   ├── sessions/             # @launchkit/sessions — bun:sqlite session store
│   ├── proxy/                # @launchkit/proxy — server, adapters, router, provider factory, serializer
│   ├── harnesses/            # @launchkit/harnesses — registry, launcher, builtins
│   └── cli/                  # @launchkit/cli — argv parse + commands (launch/list/add/remove)
│
└── tooling/
    ├── tsconfig/             # shared tsconfig presets (base, package, react)
    └── biome-config/         # shared Biome preset
```

**Domain mapping (architecture `src/*` → package):** `proxy → packages/proxy`, `harnesses → packages/harnesses`, `config → packages/config`, `sessions → packages/sessions`, `cli → packages/cli`, `gui + views → apps/desktop` (composing `packages/ui` + `packages/ipc`), inline core types → `packages/types`.

**Dependency DAG (defines build order and parallelism):**

```
types ──► utils ──► secrets ─┐
              │     ipc ──────┼──► config ──► proxy ──┐
              │     ui ───────┘    sessions ─► harnesses ─► cli ──► apps/desktop
              └────────────────────────────────────────────────────┘
```

Build/implement order: `types → utils → {secrets, ipc, ui} → {config, sessions} → {proxy, harnesses} → cli → desktop`. Braced groups are independent and can be implemented by **parallel subagents**.

**Package contract rules** (enforced in `02-monorepo/boundaries.md`): every package exposes a single public barrel (`src/index.ts`); cross-package imports go through the package name only (`@launchkit/x`), never deep paths; no cyclic edges; the DAG above is the allowed-edge whitelist.

---

## 5. Conventions

### TypeScript
- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- `any` is banned (Biome rule); use `unknown` + zod narrowing at boundaries.
- **Every function declares explicit input and output types** — no relying on inference for public signatures.

### Functional style
- Default to pure functions. Side effects (filesystem, network, `spawn`, `bun:sqlite`, clock, randomness) are isolated behind small **injected adapter interfaces**, so feature logic is tested with in-memory fakes and no real IO.
- Fallible operations return `Result<T, E>` (a small in-house discriminated union in `@launchkit/utils`, `neverthrow`-style) instead of throwing. Throwing is reserved for truly unrecoverable programmer errors.
- Build features by composing small single-purpose functions (`pipe`/`flow`); a function that does two things gets split.
- Data is immutable: `readonly` types, no in-place mutation.

### TDD (rigid — follows superpowers `test-driven-development`)
- `bun test`, Jest API. One behavior per `it`, named `it("does X when Y happens")`.
- Strict RED → GREEN → REFACTOR: write the failing test first, confirm it fails for the right reason, implement the minimum to pass, then refactor with tests green.
- Tests co-located as `*.test.ts` beside source.
- React components tested with `@testing-library/react` on **happy-dom**, registered via a `bun test` preload in `bunfig.toml`.
- Effectful units tested through their injected fakes; a thin layer of integration tests exercises real IO (real sqlite temp file, real `Bun.serve` on an ephemeral port, a mock AI SDK provider).
- Proxy adapters get **contract tests** against captured Anthropic/OpenAI request & SSE fixtures.

### Atomic design (React UI only)
- `atoms` (Button, Input, Badge, StatusDot) → `molecules` (FormField, ProviderCard, AliasRow) → `organisms` (ProviderList, AliasTable, HarnessForm) → `templates` (page shells/layouts) → `pages` (Dashboard, Providers, Routing, Harnesses, Sessions).
- Components are pure and presentational with typed props. **Dumb components never fetch** — data enters at the page level via an IPC-client hook and flows down as props.

### Git / definition-of-done
- Conventional commits referencing the task ID: `feat(proxy): add anthropic inbound adapter [proxy-03]`.
- A task is **done** only when: tests written first, implementation passes them, refactor done, `typecheck` + `biome` + `bun test` all green, `PROGRESS.md` updated, and the work committed.

---

## 6. CLAUDE rules + project skills

**Root `CLAUDE.md`** encodes the always-on rules: TS strictness, functional style, mandatory TDD with the naming convention, the security checklist highlights, package-boundary rules, and a pointer to `build-plan/EXECUTION.md` for how to resume. It explicitly states: *user instructions and these rules override default behavior; always run skills.*

**Per-package `CLAUDE.md`** gives local context (e.g. `packages/proxy/CLAUDE.md` documents the adapter pattern and the no-buffering streaming rule; `packages/ui/CLAUDE.md` documents the atomic hierarchy).

**Project skills** (in `.claude/skills/`, complementing — not duplicating — superpowers skills):
- `launchkit-resume` — the canonical resume workflow: read `PROGRESS.md` → pick first unblocked task → load its plan file → execute via the superpowers TDD + executing-plans skills → verify → update ledger → commit → repeat.
- `launchkit-new-package` — scaffold a new internal package with the standard structure (tsconfig extend, `src/index.ts` barrel, test setup, `CLAUDE.md`).
- `launchkit-add-provider` — add a new `@ai-sdk/*` provider to the factory (the architecture stresses provider extensibility).
- `launchkit-add-harness` — add a built-in harness definition (declarative `envTemplate` shape).
- `launchkit-atomic-component` — add a React atomic component with typed props, co-located test, and correct hierarchy placement.

We deliberately reuse existing superpowers skills (`test-driven-development`, `executing-plans`, `subagent-driven-development`, `writing-plans`, `verification-before-completion`, `requesting-code-review`, `dispatching-parallel-agents`) rather than re-implementing them.

---

## 7. Security plan ("optimal")

This intentionally **overrides** the architecture doc's "store API keys as-is for now."

- **Secrets:** API keys/credentials live in the macOS Keychain via `@launchkit/secrets`. `config.json` stores only an opaque keychain reference id, never a secret value.
- **Proxy binding:** listens on `127.0.0.1` only — never `0.0.0.0`. A per-run random proxy key (`{{proxyKey}}`) is generated and required on every inbound request (defense-in-depth even on loopback).
- **Input validation:** every external input is zod-validated before use — proxy request bodies, IPC messages, `config.json`, and user harness JSON files. Reject on parse failure with a typed error.
- **Process spawning:** harnesses are launched with argument arrays (never a shell string); env-template tokens are validated; the command must resolve on `PATH` or be an explicitly allowed absolute path.
- **No secret leakage:** a redaction helper scrubs keys from all logs and error messages; secrets never cross IPC to the webview.
- **Filesystem:** atomic writes (`.tmp` + rename); `0600` perms on `config.json` and the SQLite DB.
- **SQLite:** parameterized statements only — no string interpolation.
- **Webview hardening:** strict CSP, navigation locked to app origin, no arbitrary code execution from the renderer; IPC handlers apply least privilege and validate every payload.
- **Supply chain:** committed lockfile, pinned `@ai-sdk/*` versions, minimal dependency surface, periodic `bun audit`.

## 8. Performance plan ("optimal")

- **Proxy hot path:** stream the AI SDK output straight to the response — never buffer a full response in memory; minimal per-request allocation.
- **Provider caching:** memoize provider factory instances keyed by a hash of their config, so `createXxx()` is not re-run per request.
- **Lazy loading:** dynamic-import only the `@ai-sdk/*` packages for providers the user has actually configured, so startup doesn't pull the whole SDK matrix.
- **CLI fast path:** CLI mode never constructs the GUI/tray; it reuses an already-running proxy via a fast `/health` check before starting its own ephemeral one.
- **Config:** in-memory cache with debounced atomic writes.
- **React:** per-page code splitting, small dependency budget, virtualized long session lists.
- **Build/test:** Turborepo caching for incremental typecheck/test/build across the monorepo.

---

## 9. Resumable execution model (Approach A)

**`PROGRESS.md`** is the single source of truth for state. It lists every task grouped by package, each with: a stable **task ID** (e.g. `proxy-03`), a one-line description, **status** (`todo` / `in-progress` / `done` / `blocked`), **dependencies** (other task IDs), and the **completing commit SHA** once done. It also has a "Next available tasks" rule: a task is runnable when all its dependency tasks are `done`.

**`EXECUTION.md`** defines the protocol:
1. Read `PROGRESS.md`; compute the set of unblocked `todo` tasks.
2. For sequential work: take the first; for parallel work: an orchestrator dispatches one subagent per unblocked task in independent packages (per superpowers `dispatching-parallel-agents` / `subagent-driven-development`).
3. Each task is executed strictly via TDD using the task's plan file in `04-plans/`.
4. On completion, run the full verification gate, update `PROGRESS.md` (status + commit SHA), and commit.
5. Repeat until no `todo` tasks remain, or stop and report on a blocker.

**`README.md`** contains the **canonical resume prompt** — a single block the user can paste to any agent. In essence: *"You are implementing LaunchKit. Read `build-plan/EXECUTION.md` and `build-plan/PROGRESS.md`. Use your superpowers skills. Pick the next unblocked task, implement it fully via TDD (RED→GREEN→REFACTOR), verify (typecheck + lint + tests), update `PROGRESS.md`, and commit. Continue until no tasks remain or you hit a blocker, then report."*

Because state lives in committed files and git history, a fresh agent with no memory of prior sessions can reconstruct exactly where things stand and continue safely.

---

## 10. What `writing-plans` produces next

The `writing-plans` skill turns this design into the concrete `04-plans/*.md` task lists. Each plan file:
- Belongs to one package/phase and lists ordered, atomic tasks with stable IDs.
- For each task: the behavior to build, the **test(s) to write first** (with `it("...")` names), the public function signatures involved, the acceptance/verification commands, and dependencies.
- Is small enough that one task ≈ one focused subagent session.

The same step also generates the initial `PROGRESS.md` (all tasks `todo`) and the `EXECUTION.md` protocol, the `01-conventions/*`, `02-monorepo/*`, `03-claude-config/*` content, and the `README.md` resume prompt.

I may fan out parallel subagents to author independent plan files concurrently.

---

## 11. Non-goals (carried from the architecture doc)

- No bundled Ollama or other binaries — users bring their own installs.
- No chat UI — harnesses run in their own terminals; LaunchKit tracks sessions only.
- No auth/multi-user — single-user local tool.
- No auto-update for v1 — Electrobun's updater can be wired later.

These are out of scope for the build plan and must not be added speculatively (YAGNI).
