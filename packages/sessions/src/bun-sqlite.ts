import { Database as BunDatabase, type Statement } from "bun:sqlite"
import { type Result, err, ok } from "@launchkit/utils"
import type { Database, SessionError } from "./db"

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Real sqlite adapter. Prepared statements are created once per distinct SQL string and
 * reused (performance.md), and every value is bound via params (security.md) — never interpolated.
 */
export const createBunSqliteDatabase = (path: string): Database => {
  const conn = new BunDatabase(path)
  const prepared = new Map<string, Statement>()

  const prepare = (sql: string): Statement => {
    const existing = prepared.get(sql)
    if (existing !== undefined) return existing
    const stmt = conn.prepare(sql)
    prepared.set(sql, stmt)
    return stmt
  }

  return {
    exec: (sql: string): Result<void, SessionError> => {
      try {
        conn.exec(sql)
        return ok(undefined)
      } catch (cause) {
        return err({ kind: "db-failed", detail: detailOf(cause) })
      }
    },

    run: (
      sql: string,
      params: readonly unknown[],
    ): Result<void, SessionError> => {
      try {
        prepare(sql).run(...(params as unknown[]))
        return ok(undefined)
      } catch (cause) {
        return err({ kind: "db-failed", detail: detailOf(cause) })
      }
    },

    all: (
      sql: string,
      params: readonly unknown[],
    ): Result<readonly Record<string, unknown>[], SessionError> => {
      try {
        const rows = prepare(sql).all(...(params as unknown[])) as Record<
          string,
          unknown
        >[]
        return ok(rows)
      } catch (cause) {
        return err({ kind: "db-failed", detail: detailOf(cause) })
      }
    },

    get: (
      sql: string,
      params: readonly unknown[],
    ): Result<Record<string, unknown> | undefined, SessionError> => {
      try {
        const row = prepare(sql).get(...(params as unknown[])) as Record<
          string,
          unknown
        > | null
        return ok(row ?? undefined)
      } catch (cause) {
        return err({ kind: "db-failed", detail: detailOf(cause) })
      }
    },
  }
}
