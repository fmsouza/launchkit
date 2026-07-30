import type { AgentDriver } from "@spectrum/agent-driver"
import { createDriver } from "@spectrum/driver-runtime"
import type { SessionId } from "@spectrum/types"
import type { IdGen } from "@spectrum/utils"
import type { AcpConnect } from "./acp-client"
import { createAcpAdapter } from "./adapter"

export interface AcpDriverDeps {
  readonly idGen: IdGen
  readonly connect?: AcpConnect
  readonly scheduler?: (fn: () => void) => void
  readonly setResumeId?: (sessionId: SessionId, resumeId: string) => void
}

/**
 * `realAcpConnect` — the real transport seam. Lazy-loads `@agentclientprotocol/sdk`,
 * spawns the agent binary with stdin/stdout pipes, and wires the SDK's stdio transport.
 *
 * NOTE: the real SDK integration is verified per-harness in tickets #119-#122. The adapter
 * is tested with an injected fake `AcpConnect`; this real connector is the production path.
 */
const realAcpConnect: AcpConnect = async () => {
  throw new Error(
    "acp transport not available: @agentclientprotocol/sdk integration pending (see tickets #119-#122)",
  )
}

export const createAcpDriver = (deps: AcpDriverDeps): AgentDriver =>
  createDriver({
    adapter: createAcpAdapter({ connect: deps.connect ?? realAcpConnect }),
    idGen: deps.idGen,
    ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
    ...(deps.setResumeId !== undefined
      ? { setResumeId: deps.setResumeId }
      : {}),
  })
