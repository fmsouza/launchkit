import { type Result, ok } from "@launchkit/utils"

/** Typed failures for every sqlite operation. Never thrown — always returned. */
export type SessionError =
  | { readonly kind: "not-found" }
  | { readonly kind: "db-failed"; readonly detail: string }

/**
 * The injected sqlite effect. Parameter-bound only: values are passed in `params`,
 * never interpolated into `sql`. `exec` is for schema/DDL (no params).
 */
export interface Database {
  exec(sql: string): Result<void, SessionError>
  run(sql: string, params: readonly unknown[]): Result<void, SessionError>
  all(
    sql: string,
    params: readonly unknown[],
  ): Result<readonly Record<string, unknown>[], SessionError>
  get(
    sql: string,
    params: readonly unknown[],
  ): Result<Record<string, unknown> | undefined, SessionError>
}

/** A statement captured by the in-memory fake so tests can assert parameterization. */
export type RecordedStatement = {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** Test-only recording fake. Captures every {sql, params} and minimally interprets the store's statements. */
export interface InMemoryDatabase extends Database {
  statements(): readonly RecordedStatement[]
}

type Row = Record<string, unknown>

const firstKeyword = (sql: string): string =>
  (sql.trim().split(/\s+/, 1)[0] ?? "").toUpperCase()

/** Parse the `(a, b, c)` column list of an INSERT. */
const parseInsertColumns = (sql: string): readonly string[] => {
  const match = /\(([^)]*)\)\s*VALUES/i.exec(sql)
  if (match === null || match[1] === undefined) return []
  return match[1]
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

/** Parse the `SET a = ?, b = ?` assignment column names of an UPDATE, in order. */
const parseUpdateColumns = (sql: string): readonly string[] => {
  const match = /SET\s+(.*?)\s+WHERE/i.exec(sql)
  if (match === null || match[1] === undefined) return []
  return match[1]
    .split(",")
    .map((a) => (a.split("=", 1)[0] ?? "").trim())
    .filter((c) => c.length > 0)
}

/** A WHERE predicate parsed from `col OP ?` (OP is `=` or `>=`). */
type WhereTerm = { readonly column: string; readonly op: "=" | ">=" }

/** Parse `WHERE x = ? AND y >= ?` into ordered terms; returns [] when there is no WHERE. */
const parseWhereTerms = (sql: string): readonly WhereTerm[] => {
  const match = /WHERE\s+(.*?)(?:\s+ORDER\s+BY|\s*$)/i.exec(sql)
  if (match === null || match[1] === undefined) return []
  return match[1]
    .split(/\s+AND\s+/i)
    .map((clause): WhereTerm | undefined => {
      const ge = /^(\w+)\s*>=\s*\?$/.exec(clause.trim())
      if (ge !== null && ge[1] !== undefined) return { column: ge[1], op: ">=" }
      const eq = /^(\w+)\s*=\s*\?$/.exec(clause.trim())
      if (eq !== null && eq[1] !== undefined) return { column: eq[1], op: "=" }
      return undefined
    })
    .filter((t): t is WhereTerm => t !== undefined)
}

const matchesWhere = (
  row: Row,
  terms: readonly WhereTerm[],
  params: readonly unknown[],
): boolean =>
  terms.every((term, i) => {
    const value = params[i]
    const cell = row[term.column]
    if (term.op === ">=")
      return (
        typeof cell === "string" && typeof value === "string" && cell >= value
      )
    return cell === value
  })

const compareDesc = (a: Row, b: Row): number => {
  const av = typeof a.startedAt === "string" ? (a.startedAt as string) : ""
  const bv = typeof b.startedAt === "string" ? (b.startedAt as string) : ""
  return av < bv ? 1 : av > bv ? -1 : 0
}

export const createInMemoryDatabase = (): InMemoryDatabase => {
  const rows = new Map<string, Row>()
  const log: RecordedStatement[] = []

  const record = (sql: string, params: readonly unknown[]): void => {
    log.push({ sql, params: [...params] })
  }

  return {
    statements: () => log,

    exec: (sql) => {
      record(sql, [])
      return ok(undefined)
    },

    run: (sql, params) => {
      record(sql, params)
      const keyword = firstKeyword(sql)
      if (keyword === "INSERT") {
        const columns = parseInsertColumns(sql)
        const row: Row = {}
        columns.forEach((col, i) => {
          row[col] = params[i]
        })
        const id = row.id
        if (typeof id === "string") rows.set(id, row)
        return ok(undefined)
      }
      if (keyword === "UPDATE") {
        const columns = parseUpdateColumns(sql)
        const id = params[params.length - 1]
        if (typeof id !== "string") return ok(undefined)
        const existing = rows.get(id)
        if (existing === undefined) return ok(undefined)
        const next: Row = { ...existing }
        columns.forEach((col, i) => {
          next[col] = params[i]
        })
        rows.set(id, next)
        return ok(undefined)
      }
      return ok(undefined)
    },

    all: (sql, params) => {
      record(sql, params)
      const terms = parseWhereTerms(sql)
      const matched = [...rows.values()].filter((row) =>
        matchesWhere(row, terms, params),
      )
      return ok([...matched].sort(compareDesc))
    },

    get: (sql, params) => {
      record(sql, params)
      const id = params[0]
      if (typeof id !== "string") return ok(undefined)
      return ok(rows.get(id))
    },
  }
}
