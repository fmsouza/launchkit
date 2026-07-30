import type { AgentDriver } from "@spectrum/agent-driver"
import { createDriver } from "@spectrum/driver-runtime"
import type { SessionId } from "@spectrum/types"
import type { IdGen } from "@spectrum/utils"
import type { AcpConnect } from "./acp-client"
import { createAcpAdapter } from "./adapter"
import { type AcpSpawn, createRealAcpConnect } from "./real-connect"

export interface AcpDriverDeps {
  readonly idGen: IdGen
  /** Override the transport in tests; production spawns the agent over stdio. */
  readonly connect?: AcpConnect
  /**
   * Parent env merged UNDER the per-run env, so the spawned agent inherits PATH/HOME. Defaults to
   * `process.env`. The packaged GUI inherits a minimal launchd PATH, so the composition root passes
   * its enriched env here rather than relying on the default.
   */
  readonly baseEnv?: () => Record<string, string | undefined>
  /** Override the process spawn in tests; production uses `Bun.spawn`. */
  readonly spawn?: AcpSpawn
  readonly scheduler?: (fn: () => void) => void
  readonly setResumeId?: (sessionId: SessionId, resumeId: string) => void
}

export const createAcpDriver = (deps: AcpDriverDeps): AgentDriver =>
  createDriver({
    adapter: createAcpAdapter({
      connect:
        deps.connect ??
        createRealAcpConnect({
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
          ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
        }),
    }),
    idGen: deps.idGen,
    ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
    ...(deps.setResumeId !== undefined
      ? { setResumeId: deps.setResumeId }
      : {}),
  })
