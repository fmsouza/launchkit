import { describe, it, expect } from "bun:test"
import { serializeAnthropicStream } from "./anthropic-stream"
import { collectStream, fromArray } from "../test-helpers"
import type { StreamEvent } from "../types"

describe("serializeAnthropicStream", () => {
  it("emits message_start, content deltas, and message_stop for a text stream", async () => {
    const events: StreamEvent[] = [
      { type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" },
      { type: "finish", finishReason: "stop" },
    ]
    const out = await collectStream(serializeAnthropicStream(fromArray(events)))
    expect(out).toContain("event: message_start")
    expect(out).toContain("content_block_delta")
    expect(out).toContain("\"text\":\"Hel\"")
    expect(out).toContain("event: message_stop")
  })
})
