import { describe, expect, it } from "bun:test"
import type { AttachmentRefWithBytes } from "@spectrum/agent-events"
import { toAcpPromptBlocks } from "./prompt-blocks"

const CAPS = { image: true, audio: false, embeddedContext: true }

const png: AttachmentRefWithBytes = {
  id: "sha_1",
  mime: "image/png",
  displayName: "shot.png",
  kind: "image",
  bytes: 3,
  dataUrl: "data:image/png;base64,AAAA",
}

const pdf: AttachmentRefWithBytes = {
  id: "sha_2",
  mime: "application/pdf",
  displayName: "spec.pdf",
  kind: "pdf",
  bytes: 3,
  dataUrl: "data:application/pdf;base64,BBBB",
}

describe("toAcpPromptBlocks", () => {
  it("builds a single text block when there are no attachments", () => {
    expect(toAcpPromptBlocks({ text: "hello", capabilities: CAPS })).toEqual([
      { type: "text", text: "hello" },
    ])
  })

  it("appends an image block carrying the base64 payload when the agent accepts images", () => {
    const blocks = toAcpPromptBlocks({
      text: "look",
      attachments: [png],
      capabilities: CAPS,
    })
    expect(blocks[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    })
  })

  it("appends an embedded resource block for a non-image attachment", () => {
    const blocks = toAcpPromptBlocks({
      text: "read",
      attachments: [pdf],
      capabilities: CAPS,
    })
    expect(blocks[1]).toEqual({
      type: "resource",
      resource: {
        uri: "file://spec.pdf",
        mimeType: "application/pdf",
        blob: "BBBB",
      },
    })
  })

  it("drops an image attachment when the agent does not accept images", () => {
    const blocks = toAcpPromptBlocks({
      text: "look",
      attachments: [png],
      capabilities: { image: false, audio: false, embeddedContext: true },
    })
    expect(blocks).toEqual([{ type: "text", text: "look" }])
  })

  it("drops a non-image attachment when the agent does not accept embedded context", () => {
    const blocks = toAcpPromptBlocks({
      text: "read",
      attachments: [pdf],
      capabilities: { image: true, audio: false, embeddedContext: false },
    })
    expect(blocks).toEqual([{ type: "text", text: "read" }])
  })

  it("drops an attachment whose dataUrl is not base64-encoded", () => {
    const blocks = toAcpPromptBlocks({
      text: "look",
      attachments: [{ ...png, dataUrl: "data:image/png,notbase64" }],
      capabilities: CAPS,
    })
    expect(blocks).toEqual([{ type: "text", text: "look" }])
  })

  it("omits the text block when the turn is attachments-only", () => {
    const blocks = toAcpPromptBlocks({
      text: "",
      attachments: [png],
      capabilities: CAPS,
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe("image")
  })

  it("keeps the attachment order given by the caller", () => {
    const blocks = toAcpPromptBlocks({
      text: "both",
      attachments: [pdf, png],
      capabilities: CAPS,
    })
    expect(blocks.map((b) => b.type)).toEqual(["text", "resource", "image"])
  })
})
