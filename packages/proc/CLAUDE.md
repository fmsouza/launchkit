# @spectrum/proc

**Responsibility:** Process primitives — command resolution (PATH lookup + traversal guard) and process spawning, as injected adapter interfaces with in-memory fakes and Bun-backed real adapters.

**Public API (barrel `src/index.ts`):** `ProcError`; `CommandResolver`/`guardCommand()`/`createFakeCommandResolver()`/`createPathCommandResolver()`; `ProcessSpawner`/`SpawnedProcess`/`SpawnCall`/`RecordingProcessSpawner`/`createRecordingProcessSpawner()`/`ControllableChild`/`ControllableProcessSpawner`/`createControllableProcessSpawner()`/`createBunProcessSpawner()`.

**Depends on:** `@spectrum/platform`, `@spectrum/utils`.

**Effects owned:** process spawn + PATH lookup — exposed to consumers as injected interfaces; never reached around.

**Local rules:** spawn takes an ARGUMENT ARRAY, never a shell string. `SpawnedProcess.kill()` sends `defaultTerminationSignal(detectPlatform())` to the CHILD ONLY — not its process group, which would require spawning `detached` and change spawn semantics for every existing consumer; a child that forks grandchildren may leak them, an accepted limitation. `guardCommand` rejects relative paths and any `..` segment BEFORE resolution. `createPathCommandResolver` passes `process.env.PATH` to `Bun.which` explicitly — `Bun.which` otherwise resolves against a process-startup PATH snapshot, which in a packaged Finder/Dock-launched app is the minimal launchd PATH. `ProcError` is a structural subset of `@spectrum/harnesses`' `HarnessError`. Two fakes, and the difference matters: `createRecordingProcessSpawner` resolves `exited` IMMEDIATELY (a foreground, one-shot launch), so anything supervising a long-lived child reads it as an instant crash and restarts in a storm — those tests use `createControllableProcessSpawner`, whose children exit only when the test says so and whose `kill()` exits the child with 143 like a real SIGTERM.
