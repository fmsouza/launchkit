import { describe, expect, it } from "bun:test"
import type { RunnerOutbound } from "@spectrum/agent-driver"
import {
  type CanonicalEvent,
  type RootRunnerMap,
  isRootRunnerFinished,
  trackRootRunner,
} from "@spectrum/agent-events"
import type { SessionId } from "@spectrum/types"
import {
  type SessionInfoResolver,
  mapRunFinished,
} from "./run-finished-mapping"

const sessionId = "sess-1" as SessionId

const frame = (inner: CanonicalEvent): RunnerOutbound => ({
  type: "runner-event",
  id: sessionId,
  event: {
    seq: 1,
    sessionId,
    ts: "2026-06-15T00:00:00.000Z",
    event: inner,
  },
})

const resolver: SessionInfoResolver = (id) =>
  id === "sess-1" ? { harnessId: "claude", cwd: "/work/proj" } : undefined

describe("mapRunFinished", () => {
  it("maps a runner-finished:errored frame to an errored RunFinished", () => {
    const result = mapRunFinished(
      frame({
        type: "runner-finished",
        runnerId: "r1" as never,
        status: "errored",
      }),
      resolver,
    )
    expect(result).toEqual({
      sessionId: "sess-1",
      harnessId: "claude",
      status: "errored",
      cwd: "/work/proj",
    })
  })

  it("maps a runner-finished:completed frame to a completed RunFinished", () => {
    const result = mapRunFinished(
      frame({
        type: "runner-finished",
        runnerId: "r1" as never,
        status: "completed",
      }),
      resolver,
    )
    expect(result).toEqual({
      sessionId: "sess-1",
      harnessId: "claude",
      status: "completed",
      cwd: "/work/proj",
    })
  })

  it("returns null for an interrupted runner-finished frame", () => {
    const result = mapRunFinished(
      frame({
        type: "runner-finished",
        runnerId: "r1" as never,
        status: "interrupted",
      }),
      resolver,
    )
    expect(result).toBeNull()
  })

  it("returns null for a non-finished event frame", () => {
    const result = mapRunFinished(
      frame({
        type: "text-delta",
        runnerId: "r1" as never,
        messageId: "m1",
        text: "hi",
      }),
      resolver,
    )
    expect(result).toBeNull()
  })

  it("falls back to an empty harnessId and omits cwd when the session is unknown", () => {
    const result = mapRunFinished(
      {
        type: "runner-event",
        id: "unknown" as SessionId,
        event: {
          seq: 1,
          sessionId: "unknown" as SessionId,
          ts: "2026-06-15T00:00:00.000Z",
          event: {
            type: "runner-finished",
            runnerId: "r1" as never,
            status: "completed",
          },
        },
      },
      resolver,
    )
    expect(result).toEqual({
      sessionId: "unknown",
      harnessId: "",
      status: "completed",
    })
  })
})

describe("native run-finished tap gating (root-aware)", () => {
  // Mirrors the composition tap: maintain a RootRunnerMap across forwarded frames via
  // `trackRootRunner`, and only notify when `isRootRunnerFinished` AND `mapRunFinished` agree.
  const startFrame = (
    runnerId: string,
    parentRunnerId?: string,
  ): RunnerOutbound =>
    frame({
      type: "runner-started",
      runnerId: runnerId as never,
      ...(parentRunnerId !== undefined
        ? { parentRunnerId: parentRunnerId as never }
        : {}),
    })

  const finishFrame = (runnerId: string): RunnerOutbound =>
    frame({
      type: "runner-finished",
      runnerId: runnerId as never,
      status: "completed",
    })

  const tap = (frames: readonly RunnerOutbound[]): (string | null)[] => {
    let roots: RootRunnerMap = new Map()
    const notified: (string | null)[] = []
    for (const f of frames) {
      if (f.type !== "runner-event") continue
      roots = trackRootRunner(roots, f.id as SessionId, f.event.event)
      if (!isRootRunnerFinished(roots, f.id as SessionId, f.event.event))
        continue
      const mapped = mapRunFinished(f, resolver)
      notified.push(mapped === null ? null : mapped.status)
    }
    return notified
  }

  it("fires for the ROOT finish and NOT for a sub-runner finish", () => {
    const notified = tap([
      startFrame("root"),
      startFrame("sub", "root"),
      finishFrame("sub"),
      finishFrame("root"),
    ])
    // Only the root finish produced a RunFinished.
    expect(notified).toEqual(["completed"])
  })

  it("fails closed: no notification when no root-started was observed", () => {
    const notified = tap([finishFrame("root")])
    expect(notified).toEqual([])
  })
})
