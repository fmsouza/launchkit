# @launchkit/harnesses

**Responsibility:** Registry (builtins + user JSON) + launcher.

**Public API (barrel `src/index.ts`):** `ALLOWED_TOKENS`, `validateEnvTemplate`, `claude`/`codex`/`opencode`/`openclaw`, `builtinHarnesses`, `createInMemoryHarnessFileSource`, `createFakeCommandResolver`, `createRecordingProcessSpawner`, `createRegistry`, `launchHarness`, `createPathCommandResolver`, `createBunProcessSpawner`, `createDirHarnessFileSource`. Type-only: `HarnessError`, `HarnessFileSource`, `CommandResolver`, `ProcessSpawner`, `SpawnCall`, `RecordingProcessSpawner`, `HarnessRegistry`, `LaunchParams`, `AllowedToken`.

**Depends on:** `@launchkit/types`, `@launchkit/utils` (see build-plan/02-monorepo/boundaries.md)

**Effects owned:** process spawn + reading harness JSON.
— exposed to consumers as injected interfaces; never reached around.

**Local rules:** spawn with arg arrays; validate command + template tokens; registry hot-reloads from disk.
