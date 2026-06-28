import { describe, expect, it } from "bun:test"
import type { UpdateState } from "@spectrum/ipc"
import { createUpdateClient } from "./updateClient"

const valid: UpdateState = {
  phase: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: "hashA",
  available: true,
  progress: 0,
  error: null,
  channel: "stable",
  showBanner: true,
}

describe("createUpdateClient", () => {
  it("dispatch invokes onUpdateState for a valid UpdateState frame", () => {
    const c = createUpdateClient()
    const received: UpdateState[] = []
    c.onUpdateState((s) => received.push(s))
    c.dispatch(valid)
    expect(received).toEqual([valid])
  })

  it("dispatch drops a malformed frame without calling the listener", () => {
    const c = createUpdateClient()
    const received: UpdateState[] = []
    c.onUpdateState((s) => received.push(s))
    c.dispatch({ phase: "available" }) // missing required fields
    c.dispatch("not-an-object")
    c.dispatch(null)
    expect(received).toEqual([])
  })

  it("onUpdateState returns an unsubscribe that stops further calls", () => {
    const c = createUpdateClient()
    const received: UpdateState[] = []
    const off = c.onUpdateState((s) => received.push(s))
    off()
    c.dispatch(valid)
    expect(received).toEqual([])
  })
})
