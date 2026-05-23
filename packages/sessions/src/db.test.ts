import { describe, expect, it } from "bun:test"
import { isErr, isOk } from "@launchkit/utils"
import { type RecordedStatement, createInMemoryDatabase } from "./db"

describe("createInMemoryDatabase", () => {
  it("records each exec as a statement with empty params when exec() is called", () => {
    const db = createInMemoryDatabase()
    const r = db.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)",
    )
    expect(isOk(r)).toBe(true)
    expect(db.statements()).toEqual([
      {
        sql: "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)",
        params: [],
      },
    ] satisfies RecordedStatement[])
  })

  it("records the sql and params separately when run() is called", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id) VALUES (?)", ["s_1"])
    const recorded = db.statements()[0]
    expect(recorded?.sql).toContain("?")
    expect(recorded?.params).toEqual(["s_1"])
  })

  it("never interpolates a param value into the recorded sql when run() is called", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id, alias) VALUES (?, ?)", ["s_1", "default"])
    const recorded = db.statements()[0]
    expect(recorded?.sql).not.toContain("s_1")
    expect(recorded?.sql).not.toContain("default")
  })

  it("round-trips an inserted row back through get() keyed by id", () => {
    const db = createInMemoryDatabase()
    db.run(
      "INSERT INTO sessions (id, harnessId, alias, startedAt) VALUES (?, ?, ?, ?)",
      ["s_1", "claude", "default", "2026-05-23T10:00:00.000Z"],
    )
    const r = db.get("SELECT * FROM sessions WHERE id = ?", ["s_1"])
    expect(isOk(r) && r.value).toEqual({
      id: "s_1",
      harnessId: "claude",
      alias: "default",
      startedAt: "2026-05-23T10:00:00.000Z",
    })
  })

  it("returns undefined from get() when no row matches the id", () => {
    const db = createInMemoryDatabase()
    const r = db.get("SELECT * FROM sessions WHERE id = ?", ["missing"])
    expect(isOk(r) && r.value).toBeUndefined()
  })

  it("applies a SET update keyed by the trailing id param when run() updates", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id, startedAt) VALUES (?, ?)", [
      "s_1",
      "2026-05-23T10:00:00.000Z",
    ])
    db.run("UPDATE sessions SET endedAt = ?, exitCode = ? WHERE id = ?", [
      "2026-05-23T10:05:00.000Z",
      0,
      "s_1",
    ])
    const r = db.get("SELECT * FROM sessions WHERE id = ?", ["s_1"])
    expect(isOk(r) && r.value).toEqual({
      id: "s_1",
      startedAt: "2026-05-23T10:00:00.000Z",
      endedAt: "2026-05-23T10:05:00.000Z",
      exitCode: 0,
    })
  })

  it("returns rows ordered by startedAt descending when all() selects without a WHERE", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id, startedAt) VALUES (?, ?)", [
      "s_old",
      "2026-05-23T09:00:00.000Z",
    ])
    db.run("INSERT INTO sessions (id, startedAt) VALUES (?, ?)", [
      "s_new",
      "2026-05-23T11:00:00.000Z",
    ])
    const r = db.all("SELECT * FROM sessions ORDER BY startedAt DESC", [])
    expect(isOk(r) && r.value.map((row) => row.id)).toEqual(["s_new", "s_old"])
  })

  it("filters rows by the WHERE columns zipped with params when all() is called", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id, harnessId, startedAt) VALUES (?, ?, ?)", [
      "s_1",
      "claude",
      "2026-05-23T09:00:00.000Z",
    ])
    db.run("INSERT INTO sessions (id, harnessId, startedAt) VALUES (?, ?, ?)", [
      "s_2",
      "codex",
      "2026-05-23T10:00:00.000Z",
    ])
    const r = db.all(
      "SELECT * FROM sessions WHERE harnessId = ? ORDER BY startedAt DESC",
      ["claude"],
    )
    expect(isOk(r) && r.value.map((row) => row.id)).toEqual(["s_1"])
  })

  it("treats a since filter as a startedAt >= comparison when all() is called", () => {
    const db = createInMemoryDatabase()
    db.run("INSERT INTO sessions (id, startedAt) VALUES (?, ?)", [
      "s_old",
      "2026-05-23T08:00:00.000Z",
    ])
    db.run("INSERT INTO sessions (id, startedAt) VALUES (?, ?)", [
      "s_new",
      "2026-05-23T12:00:00.000Z",
    ])
    const r = db.all(
      "SELECT * FROM sessions WHERE startedAt >= ? ORDER BY startedAt DESC",
      ["2026-05-23T10:00:00.000Z"],
    )
    expect(isOk(r) && r.value.map((row) => row.id)).toEqual(["s_new"])
  })

  it("never reports an error for the statements the store issues", () => {
    const db = createInMemoryDatabase()
    expect(
      isErr(db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT)")),
    ).toBe(false)
  })
})
