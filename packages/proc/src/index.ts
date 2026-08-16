export type { ProcError } from "./errors"
export type { CommandResolver } from "./command-resolver"
export { guardCommand, createFakeCommandResolver } from "./command-resolver"
export type {
  ProcessSpawner,
  SpawnedProcess,
  SpawnCall,
  RecordingProcessSpawner,
} from "./process-spawner"
export { createRecordingProcessSpawner } from "./process-spawner"
export { createPathCommandResolver, createBunProcessSpawner } from "./adapters"
