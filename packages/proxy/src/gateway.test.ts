import { describe, it, expect } from "bun:test"
import { createScriptedGateway } from "./gateway"
import type { StreamEvent } from "./types"

describe("createScriptedGateway", () => {
  it("yields the scripted events when stream() is called", async () => {
    const scripted: StreamEvent[] = [{ type: "text-delta", text: "x" }, { type: "finish", finishReason: "stop" }]
    const gw = createScriptedGateway(scripted)
    const got: StreamEvent[] = []
    for await (const e of gw.stream({}, { model: "m", messages: [{ role: "user", content: "hi" }], stream: true })) got.push(e)
    expect(got).toEqual(scripted)
  })
})
