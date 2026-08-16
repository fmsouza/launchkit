# @spectrum/proc

**Responsibility:** Process primitives — command resolution (PATH lookup + traversal guard) and process spawning, as injected adapter interfaces with in-memory fakes and Bun-backed real adapters.

**Public API (barrel `src/index.ts`):** `ProcError`; `CommandResolver`/`guardCommand()`/`createFakeCommandResolver()`/`createPathCommandResolver()`; `ProcessSpawner`/`SpawnedProcess`/`SpawnCall`/`RecordingProcessSpawner`/`createRecordingProcessSpawner()`/`createBunProcessSpawner()`.

**Depends on:** `@spectrum/platform`, `@spectrum/utils`.

**Effects owned:** process spawn + PATH lookup — exposed to consumers as injected interfaces; never reached around.

**Local rules:** spawn takes an ARGUMENT ARRAY, never a shell string. `guardCommand` rejects relative paths and any `..` segment BEFORE resolution. `createPathCommandResolver` passes `process.env.PATH` to `Bun.which` explicitly — `Bun.which` otherwise resolves against a process-startup PATH snapshot, which in a packaged Finder/Dock-launched app is the minimal launchd PATH. `ProcError` is a structural subset of `@spectrum/harnesses`' `HarnessError`.
