# @spectrum/harnesses

**Responsibility:** Registry (builtins + user JSON) + launcher.

**Public API (barrel `src/index.ts`):** `ALLOWED_TOKENS`, `validateEnvTemplate`, `claude`/`codex`/`opencode`/`openclaw`/`gemini`, `builtinHarnesses`, `createInMemoryHarnessFileSource`, `createRegistry`, `launchHarness`, `createDirHarnessFileSource`. Type-only: `HarnessError`, `HarnessFileSource`, `HarnessRegistry`, `LaunchParams`, `LaunchRoute`, `AllowedToken`. `CommandResolver`/`ProcessSpawner`/`SpawnedProcess`/`SpawnCall`/`RecordingProcessSpawner`/`createFakeCommandResolver`/`createRecordingProcessSpawner`/`createPathCommandResolver`/`createBunProcessSpawner` moved to `@spectrum/proc` — harnesses re-exports none of them.

**Depends on:** `@spectrum/proc` (command resolution + process spawning primitives), `@spectrum/types`, `@spectrum/utils`, `@spectrum/logger`

**Effects owned:** reading harness JSON. Process spawn + command resolution live in `@spectrum/proc` now; `launchHarness` consumes its `CommandResolver`/`ProcessSpawner` interfaces as injected deps and never constructs them itself.
— exposed to consumers as injected interfaces; never reached around.

`launchHarness` accepts an injected `Logger` (default noop); logs `error` on spawn/launch failure (`{ kind, detail }`; never the rendered proxy env / per-run key).

## ACP launch mode

`HarnessDefinition.acp` (`@spectrum/types`) declares how a harness is launched as an ACP agent:

```ts
acp?: {
  command?: string           // the binary that speaks ACP, when it is NOT harness.command
  args: readonly string[]    // ACP-mode flags, appended to the resolved command
  native: boolean            // true = the harness speaks ACP itself; false = a separate adapter
}
```

`resolveHarnessLaunch({ harness, route, mode: "acp" })` resolves `acp.command ?? harness.command`,
uses `acp.args` in place of `argsTemplate`, and renders the SAME proxy env as native mode (an ACP
agent still reaches the LLM through the Spectrum proxy via env vars). A harness with no `acp`
config returns `err({ kind: "no-acp-config" })`. `mode: "native"` (the default) is unchanged and is
what the CLI passthrough spawn path uses.

Non-native harnesses need a SEPARATE binary, not a flag: Claude is `claude-agent-acp`
(`@agentclientprotocol/claude-agent-acp`) and Codex is `codex-acp`
(`@agentclientprotocol/codex-acp`) — neither `claude --acp` nor `codex acp` exists. The harness's
own command is resolved only in native mode, so a missing harness binary never blocks a shim
launch.

**Local rules:** spawn with arg arrays; validate command + template tokens; registry hot-reloads from disk.
