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

describe("createSessionStore.create", () => {
  it("returns a Session with the id from idGen and ISO startedAt from the clock when create() is called", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    const r = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    expect(isOk(r) && r.value).toEqual({
      id: "s_1",
      harnessId: "claude",
      alias: "default",
      startedAt: "2026-05-23T10:00:00.000Z",
    })
  })

  it("issues a parameterized INSERT whose values live in params, not in the sql, when create() is called", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    store.create({ harnessId: "claude" as never, alias: "default" as never })
    const insert = deps.db.statements().find((s) => /^\s*INSERT/i.test(s.sql))
    expect(insert?.sql).toContain("?")
    expect(insert?.sql).not.toContain("s_1")
    expect(insert?.sql).not.toContain("claude")
    expect(insert?.sql).not.toContain("2026-05-23T10:00:00.000Z")
    expect(insert?.params).toEqual([
      "s_1",
      "claude",
      "default",
      "2026-05-23T10:00:00.000Z",
    ])
  })

  it("uses the idGen prefix 's' for the generated session id when create() is called", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    const first = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    const second = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    expect(isOk(first) && first.value.id).toBe("s_1")
    expect(isOk(second) && second.value.id).toBe("s_2")
  })

  it("returns the db-failed error when the INSERT fails", () => {
    const failing = {
      ...makeDeps(),
      db: {
        exec: () => ({ ok: true as const, value: undefined }),
        run: () => ({
          ok: false as const,
          error: { kind: "db-failed" as const, detail: "disk full" },
        }),
        all: () => ({ ok: true as const, value: [] }),
        get: () => ({ ok: true as const, value: undefined }),
      },
    }
    const store = createSessionStore(failing)
    const r = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    expect(r).toEqual({
      ok: false,
      error: { kind: "db-failed", detail: "disk full" },
    })
  })
})

describe("createSessionStore.close", () => {
  it("returns the updated Session with endedAt and exitCode when close() is called on an open session", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    const created = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    const id = isOk(created) ? created.value.id : ("" as never)
    const r = store.close(id, 0)
    expect(isOk(r) && r.value).toEqual({
      id: "s_1",
      harnessId: "claude",
      alias: "default",
      startedAt: "2026-05-23T10:00:00.000Z",
      endedAt: "2026-05-23T10:00:00.000Z",
      exitCode: 0,
    })
  })

  it("issues a parameterized UPDATE whose id is bound in params, not interpolated, when close() is called", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    const created = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    const id = isOk(created) ? created.value.id : ("" as never)
    store.close(id, 137)
    const update = deps.db.statements().find((s) => /^\s*UPDATE/i.test(s.sql))
    expect(update?.sql).toContain("?")
    expect(update?.sql).toMatch(/WHERE id = \?/i)
    expect(update?.sql).not.toContain("s_1")
    expect(update?.params).toEqual(["2026-05-23T10:00:00.000Z", 137, "s_1"])
  })

  it("returns a not-found error when close() targets an id that has no row", () => {
    const deps = makeDeps()
    const store = createSessionStore(deps)
    store.init()
    const r = store.close("s_missing" as never, 0)
    expect(r).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("returns the db-failed error when the UPDATE fails", () => {
    const failing = {
      ...makeDeps(),
      db: {
        exec: () => ({ ok: true as const, value: undefined }),
        run: () => ({
          ok: false as const,
          error: { kind: "db-failed" as const, detail: "locked" },
        }),
        all: () => ({ ok: true as const, value: [] }),
        get: () => ({ ok: true as const, value: undefined }),
      },
    }
    const store = createSessionStore(failing)
    const r = store.close("s_1" as never, 0)
    expect(r).toEqual({
      ok: false,
      error: { kind: "db-failed", detail: "locked" },
    })
  })
})
