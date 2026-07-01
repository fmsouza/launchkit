import type { AttachmentRef } from "@spectrum/agent-events"

/** Durable outbox entry: a user send persisted before dispatch so a crash can't lose it. */
export type OutboxStatus = "sending" | "failed"
export type OutboxEntry = {
  readonly clientSendId: string
  readonly text: string
  /** Attachment refs (no bytes — the dataUrl is send-only). */
  readonly attachments?: readonly AttachmentRef[]
  readonly status: OutboxStatus
}

/** Replace the entry with the same clientSendId, or append it. */
export const upsert = (
  entries: readonly OutboxEntry[],
  entry: OutboxEntry,
): OutboxEntry[] => {
  const idx = entries.findIndex((e) => e.clientSendId === entry.clientSendId)
  if (idx === -1) return [...entries, entry]
  return entries.map((e, i) => (i === idx ? entry : e))
}

/** Flip a single entry to "failed". */
export const markFailed = (
  entries: readonly OutboxEntry[],
  clientSendId: string,
): OutboxEntry[] =>
  entries.map((e) =>
    e.clientSendId === clientSendId ? { ...e, status: "failed" } : e,
  )

/** Flip every "sending" entry to "failed" (transport loss / crash recovery). */
export const failSending = (entries: readonly OutboxEntry[]): OutboxEntry[] =>
  entries.map((e) => (e.status === "sending" ? { ...e, status: "failed" } : e))

/** Drop a single entry by id. */
export const remove = (
  entries: readonly OutboxEntry[],
  clientSendId: string,
): OutboxEntry[] => entries.filter((e) => e.clientSendId !== clientSendId)

/** Drop entries whose id appears in the reduced timeline (they landed). */
export const dropConfirmed = (
  entries: readonly OutboxEntry[],
  presentIds: ReadonlySet<string>,
): OutboxEntry[] => entries.filter((e) => !presentIds.has(e.clientSendId))

/** The entries to render (not yet reconciled with the backend echo). */
export const pendingToRender = (
  entries: readonly OutboxEntry[],
  presentIds: ReadonlySet<string>,
): OutboxEntry[] => entries.filter((e) => !presentIds.has(e.clientSendId))
