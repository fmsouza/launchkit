import { describe, expect, it } from "bun:test"
import { SessionIdSchema } from "@spectrum/types"
import { decodeRunnerInbound } from "./protocol"

const id = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")

describe("decodeRunnerInbound run-send clientSendId", () => {
  it("decodes a run-send carrying a clientSendId", () => {
    const res = decodeRunnerInbound({
      type: "run-send",
      id,
      text: "hi",
      clientSendId: "c1",
    })
    expect(res.ok).toBe(true)
    if (res.ok && res.value.type === "run-send") {
      expect(res.value.clientSendId).toBe("c1")
    }
  })

  it("still decodes a run-send with no clientSendId", () => {
    const res = decodeRunnerInbound({ type: "run-send", id, text: "hi" })
    expect(res.ok).toBe(true)
  })
})
