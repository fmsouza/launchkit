export type { HarnessError } from "./errors"
export { ALLOWED_TOKENS, type AllowedToken } from "./tokens"
export { validateEnvTemplate } from "./validate-env-template"

export {
  claude,
  codex,
  opencode,
  openclaw,
  builtinHarnesses,
} from "./builtin/index"

export type { HarnessFileSource } from "./file-source"
export { createInMemoryHarnessFileSource } from "./file-source"

export type { CommandResolver } from "./command-resolver"
export { createFakeCommandResolver } from "./command-resolver"

export type {
  ProcessSpawner,
  SpawnCall,
  RecordingProcessSpawner,
} from "./process-spawner"
export { createRecordingProcessSpawner } from "./process-spawner"

export type { HarnessRegistry } from "./registry"
export { createRegistry } from "./registry"

export type { LaunchParams } from "./launch"
export { launchHarness } from "./launch"

export {
  createPathCommandResolver,
  createBunProcessSpawner,
  createDirHarnessFileSource,
} from "./adapters"
