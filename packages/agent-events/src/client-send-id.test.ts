import { describe, expect, it } from "bun:test"
import { RunnerIdSchema } from "@spectrum/types"
import { CanonicalEventSchema } from "./events"
import { type MessageItem, initialRunState, reduce } from "./reduce"

const root = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-000000000000")

describe("text-delta clientSendId", () => {
  it("parses a text-delta carrying a clientSendId", () => {
    const parsed = CanonicalEventSchema.safeParse({
      type: "text-delta",
      runnerId: root,
      messageId: "m1",
      text: "hi",
      role: "user",
      clientSendId: "c1",
    })
    expect(parsed.success).toBe(true)
  })

  it("carries clientSendId onto the user message item when reducing", () => {
    const state = reduce(
      reduce(initialRunState, {
        type: "runner-started",
        runnerId: root,
      }),
      {
        type: "text-delta",
        runnerId: root,
        messageId: "m1",
        text: "hello",
        role: "user",
        clientSendId: "c1",
      },
    )
    const item = state.runners.get(root)?.items[0] as MessageItem
    expect(item.clientSendId).toBe("c1")
  })
})
