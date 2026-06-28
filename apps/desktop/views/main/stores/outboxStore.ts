import type { SessionId } from "@spectrum/types"
import { type StoreApi, createStore } from "zustand/vanilla"
import {
  type OutboxEntry,
  dropConfirmed,
  failSending,
  markFailed as markFailedAt,
  remove as removeAt,
  upsert,
} from "./outbox"
import type { StoreDeps } from "./types"

export type OutboxStore = {
  readonly bySession: Readonly<Record<string, readonly OutboxEntry[]>>
  readonly enqueue: (sessionId: SessionId, entry: OutboxEntry) => void
  readonly markFailed: (sessionId: SessionId, clientSendId: string) => void
  readonly failAllSending: () => void
  readonly remove: (sessionId: SessionId, clientSendId: string) => void
  readonly reconcile: (
    sessionId: SessionId,
    presentIds: ReadonlySet<string>,
  ) => void
  readonly hydrate: (sessionId: SessionId) => void
}

const key = (sessionId: SessionId): string => `spectrum.outbox.${sessionId}`

const persist = (
  sessionId: SessionId,
  entries: readonly OutboxEntry[],
): void => {
  try {
    globalThis.localStorage?.setItem(key(sessionId), JSON.stringify(entries))
  } catch {
    /* storage unavailable — keep in-memory only (crash-durability lost) */
  }
}

const load = (sessionId: SessionId): OutboxEntry[] => {
  try {
    const raw = globalThis.localStorage?.getItem(key(sessionId)) ?? null
    if (!raw) return []
    const parsed = JSON.parse(raw) as OutboxEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const createOutboxStore = (_deps: StoreDeps): StoreApi<OutboxStore> =>
  createStore<OutboxStore>()((set, get) => {
    const write = (
      sessionId: SessionId,
      next: readonly OutboxEntry[],
    ): void => {
      persist(sessionId, next)
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: next } }))
    }
    return {
      bySession: {},
      enqueue: (sessionId, entry) =>
        write(sessionId, upsert(get().bySession[sessionId] ?? [], entry)),
      markFailed: (sessionId, clientSendId) =>
        write(
          sessionId,
          markFailedAt(get().bySession[sessionId] ?? [], clientSendId),
        ),
      failAllSending: () => {
        for (const [sessionId, entries] of Object.entries(get().bySession)) {
          write(sessionId as SessionId, failSending(entries))
        }
      },
      remove: (sessionId, clientSendId) =>
        write(
          sessionId,
          removeAt(get().bySession[sessionId] ?? [], clientSendId),
        ),
      reconcile: (sessionId, presentIds) =>
        write(
          sessionId,
          dropConfirmed(get().bySession[sessionId] ?? [], presentIds),
        ),
      hydrate: (sessionId) => write(sessionId, failSending(load(sessionId))),
    }
  })
