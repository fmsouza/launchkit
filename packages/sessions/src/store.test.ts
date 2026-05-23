import { describe, expect, it } from "bun:test"
import { createFixedClock, createSequentialIdGen, isOk } from "@launchkit/utils"
import { createInMemoryDatabase } from "./db"
import { createSessionStore } from "./store"

const makeDeps = () => {
  const db = createInMemoryDatabase()
  const clock = createFixedClock(new Date("2026-05-23T10:00:00.000Z"))
  const idGen = createSequentialIdGen()
  return { db, clock, idGen }
}

describe("createSessionStore.init", () => {
  it("issues a CREATE TABLE IF NOT EXISTS statement when init() is called", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    const r = store.init()
    expect(isOk(r)).toBe(true)
    const sqls = deps.db.statements().map((s) => s.sql)
    expect(
      sqls.some((s) => /CREATE TABLE IF NOT EXISTS sessions/i.test(s)),
    ).toBe(true)
  })

  it("creates an index on startedAt when init() is called", () => {
    const deps = makeDeps()
    createSessionStore(deps).init()
    const sqls = deps.db.statements().map((s) => s.sql)
    expect(
      sqls.some((s) => /CREATE INDEX IF NOT EXISTS .*startedAt/i.test(s)),
    ).toBe(true)
  })

  it("creates an index on harnessId when init() is called", () => {
    const deps = makeDeps()
    createSessionStore(deps).init()
    const sqls = deps.db.statements().map((s) => s.sql)
    expect(
      sqls.some((s) => /CREATE INDEX IF NOT EXISTS .*harnessId/i.test(s)),
    ).toBe(true)
  })

  it("declares every Session column in the CREATE TABLE statement when init() is called", () => {
    const deps = makeDeps()
    createSessionStore(deps).init()
    const create =
      deps.db
        .statements()
        .map((s) => s.sql)
        .find((s) => /CREATE TABLE/i.test(s)) ?? ""
    for (const column of [
      "id",
      "harnessId",
      "alias",
      "startedAt",
      "endedAt",
      "exitCode",
    ]) {
      expect(create).toContain(column)
    }
  })
})
