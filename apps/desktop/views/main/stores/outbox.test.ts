import { describe, expect, it } from "bun:test"
import type { AttachmentRef } from "@spectrum/agent-events"
import {
  type OutboxEntry,
  dropConfirmed,
  failSending,
  markFailed,
  pendingToRender,
  remove,
  upsert,
} from "./outbox"

const s = (
  clientSendId: string,
  status: OutboxEntry["status"],
): OutboxEntry => ({
  clientSendId,
  text: clientSendId,
  status,
})

const att: AttachmentRef = {
  id: "sha_abc",
  mime: "image/png",
  displayName: "shot.png",
  kind: "image",
  bytes: 12,
}

describe("outbox helpers", () => {
  it("upsert appends a new entry and replaces an existing one by id", () => {
    const a = upsert([], s("c1", "sending"))
    expect(a).toEqual([s("c1", "sending")])
    const b = upsert(a, s("c1", "failed"))
    expect(b).toEqual([s("c1", "failed")])
  })

  it("markFailed flips only the matching entry", () => {
    expect(markFailed([s("c1", "sending"), s("c2", "sending")], "c1")).toEqual([
      s("c1", "failed"),
      s("c2", "sending"),
    ])
  })

  it("failSending flips every sending entry to failed", () => {
    expect(failSending([s("c1", "sending"), s("c2", "failed")])).toEqual([
      s("c1", "failed"),
      s("c2", "failed"),
    ])
  })

  it("remove drops the matching entry", () => {
    expect(remove([s("c1", "failed"), s("c2", "sending")], "c1")).toEqual([
      s("c2", "sending"),
    ])
  })

  it("dropConfirmed removes entries present in the timeline", () => {
    expect(
      dropConfirmed([s("c1", "sending"), s("c2", "failed")], new Set(["c1"])),
    ).toEqual([s("c2", "failed")])
  })

  it("pendingToRender returns only unconfirmed entries", () => {
    expect(
      pendingToRender([s("c1", "sending"), s("c2", "failed")], new Set(["c1"])),
    ).toEqual([s("c2", "failed")])
  })

  it("upsert preserves attachments on a re-insert", () => {
    const e1: OutboxEntry = {
      clientSendId: "c1",
      text: "see",
      attachments: [att],
      status: "sending",
    }
    const e2: OutboxEntry = {
      clientSendId: "c1",
      text: "see",
      status: "failed",
    }
    const a = upsert([], e1)
    const b = upsert(a, e2)
    expect(b).toEqual([e2])
    // re-insert with the same attachments persists them
    const c = upsert(b, e1)
    expect(c).toEqual([e1])
    expect(c[0]?.attachments).toEqual([att])
  })
})
