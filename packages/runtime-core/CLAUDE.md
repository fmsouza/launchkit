# @spectrum/runtime-core

**Responsibility:** the shared composition root for both `apps/cli` and `apps/desktop`. Owns the base `AppContext` type, `createAppContext(deps)` (flat, logic-free wiring of real `@spectrum/*` adapters), and `CreateAppContextDeps`/`realDeps`.

**Public surface:** `src/index.ts` re-exports `AppContext`, `CreateAppContextDeps`, `createAppContext`, `realDeps`, `ProviderTestResult`, and runner-extension-point types from `src/app-context.ts` / `src/create-app-context.ts` / `src/deps.ts`.

**Depends on:** every `@spectrum/*` leaf the factory wires (agent-driver, agent-events, config, data-admin, db, driver-*, extensions, harnesses, logger, platform, proc, projects, provider-host, providers, proxy, run-store, secrets, sessions, types, utils). NOT `ipc`/`ui`/`brand`/`cli` (GUI- or CLI-app concerns).

**Effects owned:** ALL real adapter construction (fs/keychain/sqlite/process/server) — but only inside `createAppContext`, behind the `CreateAppContextDeps` seam. `realDeps` is the production wiring.

**Local rules:** NEVER import `electrobun` — enforced by `src/boundary.test.ts`. GUI-only seams (`createRunManager`, `startRunnerSocket`, `createRendererWatchdog`, `removeDir`, `relaunch`) and the `RunManager` itself live in `apps/desktop`'s `createGuiContext`, not here. Runner-extension-point fields on `AppContext` (`sessionSink`, `runStore`, `routingDriver`, `resolveResumeInput`, `resolveModelEnv`, `closeDb`, `clock`) are typed + documented "GUI runner extension points"; the CLI never reads them. `createAppContext` is flat and logic-free; every decision lives in the injected adapters.

Provider-plugin state is the one exception to "flat": `createAppContext` is SYNCHRONOUS but reading extensions from disk is not, so the plugin-derived values (`providerRegistry`, the extension registry, the supervised-contribution set) live in mutable cells that `refreshExtensions()` swaps. Consumers — including `AppContext.providerRegistry` and `AppContext.extensionRegistry` — are handed a STABLE delegating façade, never the cell's current value, which would go stale on the first swap. The initial refresh is started at construction and awaited by `resolveBaseUrl` on the routing path; a failed extension load is logged (`{ kind }`) and swallowed so startup continues on builtins only.