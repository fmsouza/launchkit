# PROGRESS — LaunchKit build ledger

**This file is the single source of truth for build state.** See `EXECUTION.md` for the protocol. Update it in the same commit as the work it tracks.

## Status legend
`todo` · `in-progress` · `done` · `blocked`

## Selection rule
A task is **runnable** when its status is `todo` AND every dependency is `done`. Pick the first runnable task top-to-bottom.

**Dependency convention:** within a package, each task depends on the previous one (`xxx-02` needs `xxx-01`). The **Deps** column lists only *cross-package* dependencies; a blank Deps cell means the task depends solely on the previous task in its package (or nothing, for the very first task). Cross-package deps reference another package's **barrel task** (its last task), which means that package is fully built.

---

## Package overview

| Order | Package | Plan file | Ready when these are `done` | Tasks | Status |
|---|---|---|---|---|---|
| 0 | bootstrap | `04-plans/00-phase0-bootstrap.md` | — | 6 | done |
| 1 | types | `04-plans/01-types.md` | phase0-06 | 7 | done |
| 1 | utils | `04-plans/02-utils.md` | phase0-06 | 7 | done |
| 2 | secrets | `04-plans/03-secrets.md` | types-07, utils-07 | 5 | done |
| 2 | ipc | `04-plans/04-ipc.md` | types-07, utils-07 | 5 | done |
| 2 | config | `04-plans/05-config.md` | types-07, utils-07 | 7 | done |
| 2 | sessions | `04-plans/06-sessions.md` | types-07, utils-07 | 7 | done |
| 2 | harnesses | `04-plans/08-harnesses.md` | types-07, utils-07 | 7 | done |
| 2 | ui | `04-plans/10-ui.md` | types-07, utils-07 | 7 | done |
| 3 | proxy | `04-plans/07-proxy.md` | types-07, utils-07, config-07, secrets-05 | 13 | done |
| 4 | cli | `04-plans/09-cli.md` | config-07, secrets-05, proxy-13, harnesses-07, sessions-07 | 6 | todo |
| 4 | gui-pages | `04-plans/12-gui-pages.md` | ui-07, ipc-05 | 7 | todo |
| 5 | desktop-shell | `04-plans/11-desktop-shell.md` | cli-06, ipc-05, proxy-13, harnesses-07, sessions-07, config-07, secrets-05 | 5 | done |
| 6 | tray-polish | `04-plans/13-tray-and-polish.md` | desktop-shell-05, gui-pages-07 (per-task deps below) | 6 | todo |

**Parallelism:** Order-1 (types, utils) → Order-2 (six packages, fully parallel) → proxy → {cli, gui-pages} → desktop-shell → tray-polish. Dispatch parallel subagents per the orchestrator section of `EXECUTION.md`.

**Total: 95 tasks.**

---

## 0 — bootstrap (`00-phase0-bootstrap.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| phase0-01 | Root workspace + tooling presets | — | done | dc16c70 |
| phase0-02 | `bun test` + DOM smoke test (first RED→GREEN) | | done | 5df3a34 |
| phase0-03 | Root `CLAUDE.md` + resume/new-package skills | | done | 8682ba4 |
| phase0-04 | Initialize the Electrobun app shell | | done | 513538a |
| phase0-05 | CI workflow | | done | 6accec6 |
| phase0-06 | Green-gate verification + cleanup | | done | c498942 |

## 1 — types (`01-types.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| types-01 | SdkProvider & ApiFormat enums | phase0-06 | done | 9f1fe79 |
| types-02 | Branded ids & SecretRef | | done | 90c670a |
| types-03 | Provider | | done | cac2540 |
| types-04 | ModelAlias | | done | 53c2527 |
| types-05 | HarnessDefinition | | done | 59ce2e9 |
| types-06 | Session | | done | 0db5613 |
| types-07 | Barrel + package CLAUDE.md | | done | fa50d2a |

## 1 — utils (`02-utils.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| utils-01 | Result core (`ok`/`err`/`isOk`/`isErr`) | phase0-06 | done | 847c341 |
| utils-02 | Result combinators | | done | 2ef4f67 |
| utils-03 | `pipe` & `flow` | | done | 5d35dc9 |
| utils-04 | `renderTemplate` | | done | 7bc92b5 |
| utils-05 | `redactSecrets` | | done | 7f4c639 |
| utils-06 | `Clock` & `IdGen` effect interfaces + adapters | | done | defcdb6 |
| utils-07 | Barrel + CLAUDE.md | | done | f221ab2 |

## 2 — secrets (`03-secrets.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| secrets-01 | SecretError + KeychainBackend interface + in-memory fake | types-07, utils-07 | done | 7c2a30e |
| secrets-02 | createSecretStore (set/get/delete/has) | | done | 38fb329 |
| secrets-03 | createMacosSecurityBackend (arg arrays + redaction) | | done | cd4d332 |
| secrets-04 | createBunProcessRunner + darwin-only integration | | done | 4ff2c10 |
| secrets-05 | Barrel + package CLAUDE.md | | done | 3d1fdd8 |

## 2 — ipc (`04-ipc.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| ipc-01 | `ProviderView` + `ProviderViewSchema` (secret-free) | types-07, utils-07 | done | |
| ipc-02 | Per-method Params/Result schemas + `IpcMethods` map | | done | |
| ipc-03 | `ClientTransport` + `createIpcClient` | | done | |
| ipc-04 | `ServerTransport` + `createIpcServer` | | done | |
| ipc-05 | In-memory transport pair, barrel + CLAUDE.md | | done | |

## 2 — config (`05-config.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| config-01 | Settings + Config schemas + defaultConfig | types-07, utils-07 | done | |
| config-02 | Migration type + migrations + runMigrations | | done | |
| config-03 | ConfigFile interface + in-memory fake | | done | |
| config-04 | createFileConfigStore.load | | done | |
| config-05 | createFileConfigStore.save (atomic) | | done | |
| config-06 | createCachedConfigStore | | done | |
| config-07 | Barrel + package CLAUDE.md | | done | |

## 2 — sessions (`06-sessions.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| sessions-01 | SessionError + Database interface + recording fake | types-07, utils-07 | done | 91fbc66 |
| sessions-02 | createSessionStore.init (schema + indexes) | | done | 2ed92c0 |
| sessions-03 | create (parameterized INSERT) | | done | d6f5988 |
| sessions-04 | close (parameterized UPDATE; not-found) | | done | f1347f0 |
| sessions-05 | query (parameterized WHERE) | | done | 125c6fe |
| sessions-06 | createBunSqliteDatabase + integration round-trip | | done | c9853d5 |
| sessions-07 | Barrel + package CLAUDE.md | | done | 884ceab |

## 2 — harnesses (`08-harnesses.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| harnesses-01 | Built-in definitions + `builtinHarnesses` list | types-07, utils-07 | done | |
| harnesses-02 | `HarnessError` + `validateEnvTemplate` | | done | |
| harnesses-03 | `HarnessFileSource` + fake + `createRegistry` | | done | |
| harnesses-04 | `CommandResolver` + `ProcessSpawner` + fakes | | done | |
| harnesses-05 | `launchHarness` | | done | |
| harnesses-06 | Real adapters + integration test | | done | |
| harnesses-07 | Barrel + package CLAUDE.md | | done | |

## 2 — ui (`10-ui.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| ui-01 | Button, StatusDot, Spinner (atoms) | types-07, utils-07 | done | 4eb21a6 |
| ui-02 | TextInput, Select, Badge, Label (atoms) | | done | 4eb21a6 |
| ui-03 | FormField, EmptyState (molecules) | | done | 4eb21a6 |
| ui-04 | ProviderCard, AliasRow (molecules) | | done | 4eb21a6 |
| ui-05 | ProviderList, AliasTable (organisms) | | done | 4eb21a6 |
| ui-06 | HarnessForm, SessionTable (organisms) | | done | 4eb21a6 |
| ui-07 | AppShell, SettingsLayout + barrels + CLAUDE.md | | done | 4eb21a6 |

## 3 — proxy (`07-proxy.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| proxy-01 | Internal request/stream types + ProxyError | types-07, utils-07, config-07, secrets-05 | done | 6d3d967 |
| proxy-02 | Request authentication | | done | 7407330 |
| proxy-03 | Anthropic inbound parser | | done | b9f9f77 |
| proxy-04 | OpenAI inbound parser | | done | 0561ec1 |
| proxy-05 | Anthropic SSE serializer | | done | 6eeb268 |
| proxy-06 | OpenAI SSE serializer | | done | 2996f1b |
| proxy-07 | Alias router | | done | ee1c513 |
| proxy-08 | Provider factory (secrets + lazy SDK + cache) | | done | cf45b00 |
| proxy-09 | LanguageModelGateway interface + fake | | done | 2622ec7 |
| proxy-10 | Request handler (wiring, no real network) | | done | c0fadc0 |
| proxy-11 | startProxy + isProxyRunning + integration test | | done | 09822a4 |
| proxy-12 | Real SDK loader + real gateway (integration) | | done | b5e1c6c |
| proxy-13 | Barrel + provider config schemas + CLAUDE.md | | done | 832780e |

## 4 — cli (`09-cli.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| cli-01 | `parseArgs` (pure argv tokenizer) | config-07, secrets-05, proxy-13, harnesses-07, sessions-07 | done | d800070 |
| cli-02 | `Writer` + `CliError` + `CliDeps` + `runCli` dispatch | | done | cf38426 |
| cli-03 | `list harnesses \| providers \| aliases` | | done | 9d88c5d |
| cli-04 | `launch <harnessId> [--model <alias>]` | | done | 5366de8 |
| cli-05 | `add` / `remove` provider + alias | | done | d013c06 |
| cli-06 | Barrel + package CLAUDE.md | | done | e4448e8 |

## 4 — gui-pages (`12-gui-pages.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| gui-pages-01 | Electrobun transport + `IpcClientContext` + fake client | ui-07, ipc-05 | done | ea1a1b2 |
| gui-pages-02 | The five data hooks over the injected client | | done | c3f661d |
| gui-pages-03 | `ProvidersPage` (no secret values + setProviderSecret) | | done | 32b5170 |
| gui-pages-04 | `RoutingPage` | | done | e1d51b7 |
| gui-pages-05 | `HarnessesPage` | | done | 79acf25 |
| gui-pages-06 | `SessionsPage` (filters + virtualization) | | done | 1d68580 |
| gui-pages-07 | `DashboardPage` + `app.tsx` router + `index.html` (CSP) | | done | 0910878 |

## 5 — desktop-shell (`11-desktop-shell.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| desktop-shell-01 | `runApp` mode router | cli-06, ipc-05, proxy-13, harnesses-07, sessions-07, config-07, secrets-05 | done | 24447a7 |
| desktop-shell-02 | `createIpcHandlers` (secret-masking boundary) | | done | 79ae95f |
| desktop-shell-03 | `createAppContext` (real-adapter wiring) | tray-polish-03 | done | f6ce6d6 |
| desktop-shell-04 | `openWindow` (Electrobun seam) + flesh out `main.ts` | | done | 08a79ab |
| desktop-shell-05 | `apps/desktop` CLAUDE.md + full gate | | done | 8827728 |

## 6 — tray-polish (`13-tray-and-polish.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| tray-polish-01 | `buildTrayMenu` pure fn + `TrayMenu`/`TrayItem` types | harnesses-07 | done | 47e1c50 |
| tray-polish-02 | `mountTray` Electrobun seam + click routing | desktop-shell-04 | done | 80f5656 |
| tray-polish-03 | `createProviderTester` (connectivity probe) | proxy-13 | done | 47e1c50 |
| tray-polish-04 | `exportConfig` / `importConfig` (pure round-trip) | config-07 | done | d807370 |
| tray-polish-05 | Final end-to-end / integration verification | desktop-shell-05, gui-pages-07, tray-polish-02, tray-polish-03, tray-polish-04 | done | d14cfe7 |
| tray-polish-06 | Wrap-up — whole-repo gate green + finalize ledger | tray-polish-05 | todo | |

---

## Integration seams (cross-plan wiring notes)

A few tasks live in one package but are wired in by another. These are intentional and the dependencies above already encode them — called out here so no agent is surprised:

- **`createProviderTester` (tray-polish-03)** is implemented in `packages/proxy` (it needs the factory + gateway) and is runnable right after `proxy-13`. The desktop `testProvider` IPC handler (`desktop-shell-02`) calls it via `AppContext.testProvider`, which `createAppContext` (`desktop-shell-03`) constructs — hence `desktop-shell-03` depends on `tray-polish-03`. Run `tray-polish-03` early (alongside `cli`/`gui-pages`), not at the end.
- **`mountTray` (tray-polish-02)** adds a call into `apps/desktop/src/main.ts`'s GUI path, which `desktop-shell-04` creates first — hence the `desktop-shell-04` dependency.
- **`exportConfig`/`importConfig` (tray-polish-04)** are added to `@launchkit/config` (so the CLI and IPC handlers can both reuse them); they only depend on `config-07`.
