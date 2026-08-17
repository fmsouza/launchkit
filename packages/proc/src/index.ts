export type { ProcError } from "./errors"
export type { CommandResolver } from "./command-resolver"
export { guardCommand, createFakeCommandResolver } from "./command-resolver"
export type {
  ProcessSpawner,
  SpawnedProcess,
  SpawnCall,
  RecordingProcessSpawner,
  ControllableChild,
  ControllableProcessSpawner,
} from "./process-spawner"
export {
  createRecordingProcessSpawner,
  createControllableProcessSpawner,
} from "./process-spawner"
export { createPathCommandResolver, createBunProcessSpawner } from "./adapters"
