import { beforeEach, describe, expect, it } from "bun:test"
import type { IpcClient } from "@spectrum/ipc"
import { SessionIdSchema } from "@spectrum/types"
import { createOutboxStore } from "./outboxStore"

const sid = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")
const deps = { client: {} as IpcClient }

beforeEach(() => globalThis.localStorage?.clear())

describe("outboxStore", () => {
  it("enqueue persists synchronously to localStorage", () => {
    const store = createOutboxStore(deps)
    store
      .getState()
      .enqueue(sid, { clientSendId: "c1", text: "hi", status: "sending" })
    expect(store.getState().bySession[sid]).toEqual([
      { clientSendId: "c1", text: "hi", status: "sending" },
    ])
    const raw = globalThis.localStorage?.getItem(`spectrum.outbox.${sid}`)
    expect(JSON.parse(raw ?? "[]")).toEqual([
      { clientSendId: "c1", text: "hi", status: "sending" },
    ])
  })

  it("hydrate marks interrupted (sending) entries as failed", () => {
    globalThis.localStorage?.setItem(
      `spectrum.outbox.${sid}`,
      JSON.stringify([{ clientSendId: "c1", text: "hi", status: "sending" }]),
    )
    const store = createOutboxStore(deps)
    store.getState().hydrate(sid)
    expect(store.getState().bySession[sid]).toEqual([
      { clientSendId: "c1", text: "hi", status: "failed" },
    ])
  })

  it("reconcile drops entries that landed in the timeline", () => {
    const store = createOutboxStore(deps)
    store
      .getState()
      .enqueue(sid, { clientSendId: "c1", text: "a", status: "sending" })
    store
      .getState()
      .enqueue(sid, { clientSendId: "c2", text: "b", status: "sending" })
    store.getState().reconcile(sid, new Set(["c1"]))
    expect(store.getState().bySession[sid]).toEqual([
      { clientSendId: "c2", text: "b", status: "sending" },
    ])
  })
})
