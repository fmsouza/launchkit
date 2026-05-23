import { describe, expect, it } from "bun:test"
import { createFixedClock, createSequentialIdGen, isOk } from "@launchkit/utils"
import { createBunSqliteDatabase } from "./bun-sqlite"
import { createSessionStore } from "./store"

describe("createBunSqliteDatabase + SessionStore", () => {
  it("round-trips init -> create -> close -> query against real bun:sqlite when run end-to-end", () => {
    const db = createBunSqliteDatabase(":memory:")
    const clock = createFixedClock(new Date("2026-05-23T10:00:00.000Z"))
    const idGen = createSequentialIdGen()
    const store = createSessionStore({ db, clock, idGen })

    expect(isOk(store.init())).toBe(true)

    const created = store.create({
      harnessId: "claude" as never,
      alias: "default" as never,
    })
    expect(isOk(created) && created.value).toEqual({
      id: "s_1",
      harnessId: "claude",
      alias: "default",
      startedAt: "2026-05-23T10:00:00.000Z",
    })

    const closed = store.close("s_1" as never, 0)
    expect(isOk(closed) && closed.value).toEqual({
      id: "s_1",
      harnessId: "claude",
      alias: "default",
      startedAt: "2026-05-23T10:00:00.000Z",
      endedAt: "2026-05-23T10:00:00.000Z",
      exitCode: 0,
    })

    const all = store.query()
    expect(isOk(all) && all.value.map((s) => s.id)).toEqual(["s_1"])
  })

  it("returns a not-found error when close() targets a missing row against real bun:sqlite", () => {
    const db = createBunSqliteDatabase(":memory:")
    const store = createSessionStore({
      db,
      clock: createFixedClock(new Date("2026-05-23T10:00:00.000Z")),
      idGen: createSequentialIdGen(),
    })
    store.init()
    const r = store.close("s_nope" as never, 0)
    expect(r).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("filters by harnessId via bound parameters when query() runs against real bun:sqlite", () => {
    const db = createBunSqliteDatabase(":memory:")
    const store = createSessionStore({
      db,
      clock: createFixedClock(new Date("2026-05-23T10:00:00.000Z")),
      idGen: createSequentialIdGen(),
    })
    store.init()
    store.create({ harnessId: "claude" as never, alias: "default" as never })
    store.create({ harnessId: "codex" as never, alias: "fast" as never })
    const r = store.query({ harnessId: "codex" as never })
    expect(isOk(r) && r.value.map((s) => s.harnessId)).toEqual(["codex"])
  })
})
