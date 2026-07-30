import type { AttachmentRefWithBytes } from "@spectrum/agent-events"
import type { AcpPromptBlock, AcpPromptCapabilities } from "./acp-client"

export interface ToAcpPromptBlocksInput {
  readonly text: string
  readonly attachments?: readonly AttachmentRefWithBytes[]
  readonly capabilities: AcpPromptCapabilities
}

/** Extract the base64 payload from a `data:<mime>;base64,<payload>` URL. Pure. */
const base64Payload = (dataUrl: string): string | undefined => {
  const marker = ";base64,"
  const at = dataUrl.indexOf(marker)
  if (at === -1) return undefined
  const payload = dataUrl.slice(at + marker.length)
  return payload === "" ? undefined : payload
}

/**
 * Build the ACP `session/prompt` content blocks for one user turn. Pure.
 *
 * Attachments the agent did NOT advertise support for in `initialize` are dropped rather than
 * sent: an agent that rejects an unsupported content block fails the whole turn, which would be a
 * worse outcome than a silently text-only prompt. The composer already gates the paperclip on the
 * same capabilities (`runner-started.supportedAttachments`), so a dropped attachment here means
 * the agent changed its mind mid-session, not that the user was misled.
 */
export const toAcpPromptBlocks = (
  input: ToAcpPromptBlocksInput,
): AcpPromptBlock[] => {
  const blocks: AcpPromptBlock[] = []
  if (input.text !== "") blocks.push({ type: "text", text: input.text })
  for (const att of input.attachments ?? []) {
    const data = base64Payload(att.dataUrl)
    if (data === undefined) continue
    if (att.kind === "image") {
      if (input.capabilities.image)
        blocks.push({ type: "image", mimeType: att.mime, data })
      continue
    }
    if (input.capabilities.embeddedContext)
      blocks.push({
        type: "resource",
        resource: {
          uri: `file://${att.displayName}`,
          mimeType: att.mime,
          blob: data,
        },
      })
  }
  return blocks
}
