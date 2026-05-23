import type { StreamEvent } from "../types"

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export const serializeAnthropicStream = (events: AsyncIterable<StreamEvent>): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(sse("message_start", { type: "message_start", message: { role: "assistant" } })))
      controller.enqueue(enc.encode(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })))
      for await (const e of events) {
        if (e.type === "text-delta") {
          controller.enqueue(enc.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: e.text } })))
        } else if (e.type === "finish") {
          controller.enqueue(enc.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })))
          controller.enqueue(enc.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: e.finishReason } })))
          controller.enqueue(enc.encode(sse("message_stop", { type: "message_stop" })))
        } else {
          controller.enqueue(enc.encode(sse("error", { type: "error", error: { message: e.detail } })))
        }
      }
      controller.close()
    },
  })
}
