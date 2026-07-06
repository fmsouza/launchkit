import { describe, expect, it } from "bun:test"
import type {
  RunLaunchInput,
  RunManager,
  RunnerInbound,
  RunnerOutbound,
} from "@spectrum/agent-driver"
import type { SessionId } from "@spectrum/types"
import { withNotifierTap } from "./runner-sink"

// A structurally valid outbound frame. The tap's fan-out is identity-agnostic, so the exact event
// payload is irrelevant — only that the SAME reference reaches both sinks exactly once.
const frame: RunnerOutbound = {
  type: "runner-event",
  id: "session-1" as SessionId,
  event: {
    seq: 0,
    sessionId: "session-1" as SessionId,
    ts: "1970-01-01T00:00:00.000Z",
    event: { type: "runner-started", runnerId: "r1" as never },
  },
}

/** A minimal RunManager whose `bindSend` captures the sink it is handed, so a test can drive it. */
const makeFakeBase = (): {
  base: RunManager
  capturedSink: () => ((message: RunnerOutbound) => void) | undefined
  launch: RunManager["launch"]
  handleInbound: RunManager["handleInbound"]
} => {
  let captured: ((message: RunnerOutbound) => void) | undefined
  const launch: RunManager["launch"] = (_input: RunLaunchInput) => ({
    ok: false,
    error: { kind: "start-failed", detail: "fake" },
  })
  const handleInbound: RunManager["handleInbound"] = (
    _message: RunnerInbound,
  ): void => {}
  const base: RunManager = {
    launch,
    handleInbound,
    bindSend: (send) => {
      captured = send
    },
    markUserNamed: () => {},
  }
  return { base, capturedSink: () => captured, launch, handleInbound }
}

describe("withNotifierTap", () => {
  it("delivers each frame to both the socket sink and the tap exactly once when the bound sink fires", () => {
    const { base, capturedSink } = makeFakeBase()
    const socketReceived: RunnerOutbound[] = []
    const tapReceived: RunnerOutbound[] = []

    const wrapped = withNotifierTap(base, (m) => tapReceived.push(m))
    wrapped.bindSend((m) => socketReceived.push(m))

    const boundSink = capturedSink()
    expect(boundSink).toBeDefined()
    boundSink?.(frame)

    expect(socketReceived).toEqual([frame])
    expect(tapReceived).toEqual([frame])
  })

  it("preserves the other RunManager methods by reference when it wraps the base", () => {
    const { base, launch, handleInbound } = makeFakeBase()

    const wrapped = withNotifierTap(base, () => {})

    expect(wrapped.launch).toBe(launch)
    expect(wrapped.handleInbound).toBe(handleInbound)
  })
})
