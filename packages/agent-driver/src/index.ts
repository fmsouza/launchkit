export const AGENT_DRIVER_PACKAGE = "@spectrum/agent-driver" as const
export type {
  AgentDriver,
  AgentSession,
  AgentStartInput,
  DriverError,
} from "./driver"
export type { FakeReaction, FakeScript } from "./fake-driver"
export { createFakeDriver, demoScript } from "./fake-driver"
export type {
  NameGenError,
  NameGeneratorPort,
  RunEventSink,
  SessionSink,
} from "./ports"
export type { RunnerInbound, RunnerOutbound } from "./protocol"
export { decodeRunnerInbound } from "./protocol"
export type { RunLaunchInput, RunManager, RunManagerDeps } from "./manager"
export { createRunManager } from "./manager"
export { SESSION_NAME_MAX, deriveSessionName } from "./derive-session-name"
