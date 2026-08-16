# @spectrum/runtime-core

**Responsibility:** the shared composition root for both `apps/cli` and `apps/desktop`. Owns the base `AppContext` type, `createAppContext(deps)` (flat, logic-free wiring of real `@spectrum/*` adapters), and `CreateAppContextDeps`/`realDeps`.

**Public surface:** `src/index.ts` re-exports `AppContext`, `CreateAppContextDeps`, `createAppContext`, `realDeps`, `ProviderTestResult`, and runner-extension-point types from `src/app-context.ts` / `src/create-app-context.ts` / `src/deps.ts`.

**Depends on:** every `@spectrum/*` leaf the factory wires (agent-driver, agent-events, config, data-admin, db, driver-*, harnesses, logger, platform, proc, projects, providers, proxy, run-store, secrets, sessions, types, utils). NOT `ipc`/`ui`/`brand`/`cli` (GUI- or CLI-app concerns).

**Effects owned:** ALL real adapter construction (fs/keychain/sqlite/process/server) — but only inside `createAppContext`, behind the `CreateAppContextDeps` seam. `realDeps` is the production wiring.

**Local rules:** NEVER import `electrobun` — enforced by `src/boundary.test.ts`. GUI-only seams (`createRunManager`, `startRunnerSocket`, `createRendererWatchdog`, `removeDir`, `relaunch`) and the `RunManager` itself live in `apps/desktop`'s `createGuiContext`, not here. Runner-extension-point fields on `AppContext` (`sessionSink`, `runStore`, `routingDriver`, `resolveResumeInput`, `resolveModelEnv`, `closeDb`, `clock`) are typed + documented "GUI runner extension points"; the CLI never reads them. `createAppContext` is flat and logic-free; every decision lives in the injected adapters.