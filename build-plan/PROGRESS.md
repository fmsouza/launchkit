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
| 0 | bootstrap | `04-plans/00-phase0-bootstrap.md` | — | 6 | todo |
| 1 | types | `04-plans/01-types.md` | phase0-06 | 7 | todo |
| 1 | utils | `04-plans/02-utils.md` | phase0-06 | 7 | todo |
| 2 | secrets | `04-plans/03-secrets.md` | types-07, utils-07 | 5 | todo |
| 2 | ipc | `04-plans/04-ipc.md` | types-07, utils-07 | 5 | todo |
| 2 | config | `04-plans/05-config.md` | types-07, utils-07 | 7 | todo |
| 2 | sessions | `04-plans/06-sessions.md` | types-07, utils-07 | 7 | todo |
| 2 | harnesses | `04-plans/08-harnesses.md` | types-07, utils-07 | 7 | todo |
| 2 | ui | `04-plans/10-ui.md` | types-07, utils-07 | 7 | todo |
| 3 | proxy | `04-plans/07-proxy.md` | types-07, utils-07, config-07, secrets-05 | 13 | todo |
| 4 | cli | `04-plans/09-cli.md` | config-07, secrets-05, proxy-13, harnesses-07, sessions-07 | 6 | todo |
| 4 | gui-pages | `04-plans/12-gui-pages.md` | ui-07, ipc-05 | 7 | todo |
| 5 | desktop-shell | `04-plans/11-desktop-shell.md` | cli-06, ipc-05, proxy-13, harnesses-07, sessions-07, config-07, secrets-05 | 5 | todo |
| 6 | tray-polish | `04-plans/13-tray-and-polish.md` | desktop-shell-05, gui-pages-07 (per-task deps below) | 6 | todo |

**Parallelism:** Order-1 (types, utils) → Order-2 (six packages, fully parallel) → proxy → {cli, gui-pages} → desktop-shell → tray-polish. Dispatch parallel subagents per the orchestrator section of `EXECUTION.md`.

**Total: 95 tasks.**

---

## 0 — bootstrap (`00-phase0-bootstrap.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| phase0-01 | Root workspace + tooling presets | — | done | dc16c70 |
| phase0-02 | `bun test` + DOM smoke test (first RED→GREEN) | | done | 5df3a34 |
| phase0-03 | Root `CLAUDE.md` + resume/new-package skills | | done | |
| phase0-04 | Initialize the Electrobun app shell | | done | 513538a |
| phase0-05 | CI workflow | | done | |
| phase0-06 | Green-gate verification + cleanup | | todo | |

## 1 — types (`01-types.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| types-01 | SdkProvider & ApiFormat enums | phase0-06 | todo | |
| types-02 | Branded ids & SecretRef | | todo | |
| types-03 | Provider | | todo | |
| types-04 | ModelAlias | | todo | |
| types-05 | HarnessDefinition | | todo | |
| types-06 | Session | | todo | |
| types-07 | Barrel + package CLAUDE.md | | todo | |

## 1 — utils (`02-utils.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| utils-01 | Result core (`ok`/`err`/`isOk`/`isErr`) | phase0-06 | todo | |
| utils-02 | Result combinators | | todo | |
| utils-03 | `pipe` & `flow` | | todo | |
| utils-04 | `renderTemplate` | | todo | |
| utils-05 | `redactSecrets` | | todo | |
| utils-06 | `Clock` & `IdGen` effect interfaces + adapters | | todo | |
| utils-07 | Barrel + CLAUDE.md | | todo | |

## 2 — secrets (`03-secrets.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| secrets-01 | SecretError + KeychainBackend interface + in-memory fake | types-07, utils-07 | todo | |
| secrets-02 | createSecretStore (set/get/delete/has) | | todo | |
| secrets-03 | createMacosSecurityBackend (arg arrays + redaction) | | todo | |
| secrets-04 | createBunProcessRunner + darwin-only integration | | todo | |
| secrets-05 | Barrel + package CLAUDE.md | | todo | |

## 2 — ipc (`04-ipc.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| ipc-01 | `ProviderView` + `ProviderViewSchema` (secret-free) | types-07, utils-07 | todo | |
| ipc-02 | Per-method Params/Result schemas + `IpcMethods` map | | todo | |
| ipc-03 | `ClientTransport` + `createIpcClient` | | todo | |
| ipc-04 | `ServerTransport` + `createIpcServer` | | todo | |
| ipc-05 | In-memory transport pair, barrel + CLAUDE.md | | todo | |

## 2 — config (`05-config.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| config-01 | Settings + Config schemas + defaultConfig | types-07, utils-07 | todo | |
| config-02 | Migration type + migrations + runMigrations | | todo | |
| config-03 | ConfigFile interface + in-memory fake | | todo | |
| config-04 | createFileConfigStore.load | | todo | |
| config-05 | createFileConfigStore.save (atomic) | | todo | |
| config-06 | createCachedConfigStore | | todo | |
| config-07 | Barrel + package CLAUDE.md | | todo | |

## 2 — sessions (`06-sessions.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| sessions-01 | SessionError + Database interface + recording fake | types-07, utils-07 | todo | |
| sessions-02 | createSessionStore.init (schema + indexes) | | todo | |
| sessions-03 | create (parameterized INSERT) | | todo | |
| sessions-04 | close (parameterized UPDATE; not-found) | | todo | |
| sessions-05 | query (parameterized WHERE) | | todo | |
| sessions-06 | createBunSqliteDatabase + integration round-trip | | todo | |
| sessions-07 | Barrel + package CLAUDE.md | | todo | |

## 2 — harnesses (`08-harnesses.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| harnesses-01 | Built-in definitions + `builtinHarnesses` list | types-07, utils-07 | todo | |
| harnesses-02 | `HarnessError` + `validateEnvTemplate` | | todo | |
| harnesses-03 | `HarnessFileSource` + fake + `createRegistry` | | todo | |
| harnesses-04 | `CommandResolver` + `ProcessSpawner` + fakes | | todo | |
| harnesses-05 | `launchHarness` | | todo | |
| harnesses-06 | Real adapters + integration test | | todo | |
| harnesses-07 | Barrel + package CLAUDE.md | | todo | |

## 2 — ui (`10-ui.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| ui-01 | Button, StatusDot, Spinner (atoms) | types-07, utils-07 | todo | |
| ui-02 | TextInput, Select, Badge, Label (atoms) | | todo | |
| ui-03 | FormField, EmptyState (molecules) | | todo | |
| ui-04 | ProviderCard, AliasRow (molecules) | | todo | |
| ui-05 | ProviderList, AliasTable (organisms) | | todo | |
| ui-06 | HarnessForm, SessionTable (organisms) | | todo | |
| ui-07 | AppShell, SettingsLayout + barrels + CLAUDE.md | | todo | |

## 3 — proxy (`07-proxy.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| proxy-01 | Internal request/stream types + ProxyError | types-07, utils-07, config-07, secrets-05 | todo | |
| proxy-02 | Request authentication | | todo | |
| proxy-03 | Anthropic inbound parser | | todo | |
| proxy-04 | OpenAI inbound parser | | todo | |
| proxy-05 | Anthropic SSE serializer | | todo | |
| proxy-06 | OpenAI SSE serializer | | todo | |
| proxy-07 | Alias router | | todo | |
| proxy-08 | Provider factory (secrets + lazy SDK + cache) | | todo | |
| proxy-09 | LanguageModelGateway interface + fake | | todo | |
| proxy-10 | Request handler (wiring, no real network) | | todo | |
| proxy-11 | startProxy + isProxyRunning + integration test | | todo | |
| proxy-12 | Real SDK loader + real gateway (integration) | | todo | |
| proxy-13 | Barrel + provider config schemas + CLAUDE.md | | todo | |

## 4 — cli (`09-cli.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| cli-01 | `parseArgs` (pure argv tokenizer) | config-07, secrets-05, proxy-13, harnesses-07, sessions-07 | todo | |
| cli-02 | `Writer` + `CliError` + `CliDeps` + `runCli` dispatch | | todo | |
| cli-03 | `list harnesses \| providers \| aliases` | | todo | |
| cli-04 | `launch <harnessId> [--model <alias>]` | | todo | |
| cli-05 | `add` / `remove` provider + alias | | todo | |
| cli-06 | Barrel + package CLAUDE.md | | todo | |

## 4 — gui-pages (`12-gui-pages.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| gui-pages-01 | Electrobun transport + `IpcClientContext` + fake client | ui-07, ipc-05 | todo | |
| gui-pages-02 | The five data hooks over the injected client | | todo | |
| gui-pages-03 | `ProvidersPage` (no secret values + setProviderSecret) | | todo | |
| gui-pages-04 | `RoutingPage` | | todo | |
| gui-pages-05 | `HarnessesPage` | | todo | |
| gui-pages-06 | `SessionsPage` (filters + virtualization) | | todo | |
| gui-pages-07 | `DashboardPage` + `app.tsx` router + `index.html` (CSP) | | todo | |

## 5 — desktop-shell (`11-desktop-shell.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| desktop-shell-01 | `runApp` mode router | cli-06, ipc-05, proxy-13, harnesses-07, sessions-07, config-07, secrets-05 | todo | |
| desktop-shell-02 | `createIpcHandlers` (secret-masking boundary) | | todo | |
| desktop-shell-03 | `createAppContext` (real-adapter wiring) | tray-polish-03 | todo | |
| desktop-shell-04 | `openWindow` (Electrobun seam) + flesh out `main.ts` | | todo | |
| desktop-shell-05 | `apps/desktop` CLAUDE.md + full gate | | todo | |

## 6 — tray-polish (`13-tray-and-polish.md`)

| ID | Task | Deps | Status | Commit |
|---|---|---|---|---|
| tray-polish-01 | `buildTrayMenu` pure fn + `TrayMenu`/`TrayItem` types | harnesses-07 | todo | |
| tray-polish-02 | `mountTray` Electrobun seam + click routing | desktop-shell-04 | todo | |
| tray-polish-03 | `createProviderTester` (connectivity probe) | proxy-13 | todo | |
| tray-polish-04 | `exportConfig` / `importConfig` (pure round-trip) | config-07 | todo | |
| tray-polish-05 | Final end-to-end / integration verification | desktop-shell-05, gui-pages-07, tray-polish-02, tray-polish-03, tray-polish-04 | todo | |
| tray-polish-06 | Wrap-up — whole-repo gate green + finalize ledger | tray-polish-05 | todo | |

---

## Integration seams (cross-plan wiring notes)

A few tasks live in one package but are wired in by another. These are intentional and the dependencies above already encode them — called out here so no agent is surprised:

- **`createProviderTester` (tray-polish-03)** is implemented in `packages/proxy` (it needs the factory + gateway) and is runnable right after `proxy-13`. The desktop `testProvider` IPC handler (`desktop-shell-02`) calls it via `AppContext.testProvider`, which `createAppContext` (`desktop-shell-03`) constructs — hence `desktop-shell-03` depends on `tray-polish-03`. Run `tray-polish-03` early (alongside `cli`/`gui-pages`), not at the end.
- **`mountTray` (tray-polish-02)** adds a call into `apps/desktop/src/main.ts`'s GUI path, which `desktop-shell-04` creates first — hence the `desktop-shell-04` dependency.
- **`exportConfig`/`importConfig` (tray-polish-04)** are added to `@launchkit/config` (so the CLI and IPC handlers can both reuse them); they only depend on `config-07`.
