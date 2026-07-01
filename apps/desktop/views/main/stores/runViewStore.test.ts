import { describe, expect, it } from "bun:test"
import type { CanonicalEvent } from "@spectrum/agent-events"
import { RunnerIdSchema, SessionIdSchema } from "@spectrum/types"
import type { RunnerId, SessionId } from "@spectrum/types"
import { createRunViewStore } from "./runViewStore"

const sid = SessionIdSchema.parse("s_00000000-0000-4000-8000-000000000000")
const root = RunnerIdSchema.parse("run_root")
const child = RunnerIdSchema.parse("run_child")

const noDeps = { client: {} as never }

describe("runViewStore", () => {
  it("folds a runner-started event into a RunState for the session", () => {
    const store = createRunViewStore(noDeps)
    const ev: CanonicalEvent = { type: "runner-started", runnerId: root }
    store.getState().applyEvent(sid, ev)
    const state = store.getState().byId[sid]
    expect(state?.rootRunnerId).toBe(root)
    expect(state?.runners.get(root)?.status).toBe("running")
  })

  it("accumulates a text-delta onto the runner's message item", () => {
    const store = createRunViewStore(noDeps)
    const events: readonly CanonicalEvent[] = [
      { type: "runner-started", runnerId: root },
      { type: "text-delta", runnerId: root, messageId: "m1", text: "Hel" },
      { type: "text-delta", runnerId: root, messageId: "m1", text: "lo" },
    ]
    for (const e of events) store.getState().applyEvent(sid, e)
    const item = store.getState().byId[sid]?.runners.get(root)?.items[0]
    expect(item?.kind).toBe("message")
    expect(item?.kind === "message" ? item.text : "").toBe("Hello")
  })

  it("reset clears a session's RunState", () => {
    const store = createRunViewStore(noDeps)
    store.getState().applyEvent(sid, { type: "runner-started", runnerId: root })
    store.getState().reset(sid)
    expect(store.getState().byId[sid]).toBeUndefined()
  })

  it("tracks busy: a user turn sets it; the root turn/runner finishing clears it", () => {
    const store = createRunViewStore(noDeps)
    const apply = (e: CanonicalEvent): void =>
      store.getState().applyEvent(sid, e)
    apply({ type: "runner-started", runnerId: root })
    expect(store.getState().busyBySession[sid] ?? false).toBe(false)
    apply({
      type: "text-delta",
      runnerId: root,
      messageId: "u1",
      text: "go",
      role: "user",
    })
    expect(store.getState().busyBySession[sid]).toBe(true)
    apply({ type: "text-delta", runnerId: root, messageId: "a1", text: "ok" })
    expect(store.getState().busyBySession[sid]).toBe(true)
    // a sub-runner finishing must NOT clear the root's busy
    apply({ type: "runner-finished", runnerId: child, status: "completed" })
    expect(store.getState().busyBySession[sid]).toBe(true)
    apply({ type: "turn-finished", runnerId: root })
    expect(store.getState().busyBySession[sid]).toBe(false)
  })

  it("openSub records the open sub-runner and closeSub clears it", () => {
    const store = createRunViewStore(noDeps)
    store.getState().openSub(sid, child)
    expect(store.getState().openSubBySession[sid]).toBe(child)
    store.getState().closeSub(sid)
    expect(store.getState().openSubBySession[sid]).toBeUndefined()
  })

  it("stores the selected mode per session and clears it on reset", () => {
    const store = createRunViewStore(noDeps)
    store.getState().setMode(sid, "bypass")
    expect(store.getState().modeBySession[sid]).toBe("bypass")
    store.getState().reset(sid)
    expect(store.getState().modeBySession[sid]).toBeUndefined()
  })

  it("seeds the composer mode from runner-started.permissionMode and does not clobber it on re-emit", () => {
    const store = createRunViewStore(noDeps)
    store.getState().applyEvent(sid, {
      type: "runner-started",
      runnerId: root,
      permissionMode: "plan",
    })
    expect(store.getState().modeBySession[sid]).toBe("plan")
    // The harness may re-emit runner-started (e.g. claude's system/init) without a permissionMode;
    // that must not reset the already-seeded mode.
    store.getState().applyEvent(sid, { type: "runner-started", runnerId: root })
    expect(store.getState().modeBySession[sid]).toBe("plan")
  })

  it("seeds the model from runner-started.model and exposes setModel/reset", () => {
    const store = createRunViewStore(noDeps)
    store.getState().applyEvent(sid, {
      type: "runner-started",
      runnerId: root,
      model: "mdl_x",
    })
    expect(store.getState().modelBySession[sid]).toBe("mdl_x")
    store.getState().setModel(sid, "mdl_y")
    expect(store.getState().modelBySession[sid]).toBe("mdl_y")
    store.getState().reset(sid)
    expect(store.getState().modelBySession[sid]).toBeUndefined()
  })

  it("seedModeModel seeds mode and model when neither is set", () => {
    const store = createRunViewStore(noDeps)
    store.getState().seedModeModel(sid, { mode: "plan", model: "mdl_x" })
    expect(store.getState().modeBySession[sid]).toBe("plan")
    expect(store.getState().modelBySession[sid]).toBe("mdl_x")
  })

  it("seedModeModel is idempotent and does not clobber an existing value", () => {
    const store = createRunViewStore(noDeps)
    store.getState().setMode(sid, "bypass")
    store.getState().setModel(sid, "mdl_existing")
    store.getState().seedModeModel(sid, { mode: "plan", model: "mdl_x" })
    expect(store.getState().modeBySession[sid]).toBe("bypass")
    expect(store.getState().modelBySession[sid]).toBe("mdl_existing")
  })

  it("seedModeModel no-ops when seed has neither mode nor model", () => {
    const store = createRunViewStore(noDeps)
    store.getState().seedModeModel(sid, {})
    expect(store.getState().modeBySession[sid]).toBeUndefined()
    expect(store.getState().modelBySession[sid]).toBeUndefined()
  })

  it("seedModeModel seeds only the fields that are present", () => {
    const store = createRunViewStore(noDeps)
    store.getState().seedModeModel(sid, { mode: "auto-edits" })
    expect(store.getState().modeBySession[sid]).toBe("auto-edits")
    expect(store.getState().modelBySession[sid]).toBeUndefined()
  })

  it("seedModeModel seeds effort when supplied and does not clobber an existing value", () => {
    const store = createRunViewStore(noDeps)
    store.getState().seedModeModel(sid, { effort: "high" })
    expect(store.getState().thinkingEffortBySession[sid]).toBe("high")
    // idempotent: already set, must not clobber
    store.getState().seedModeModel(sid, { effort: "low" })
    expect(store.getState().thinkingEffortBySession[sid]).toBe("high")
  })

  it("seeds thinking-effort from runner-started without clobbering a user change", () => {
    const store = createRunViewStore({} as never)
    store.getState().applyEvent("s1" as SessionId, {
      type: "runner-started",
      runnerId: "r1" as RunnerId,
      thinkingEffort: "high",
    })
    expect(store.getState().thinkingEffortBySession.s1).toBe("high")
    // A later re-emit must not clobber a user change.
    store.getState().setThinkingEffort("s1" as SessionId, "off")
    store.getState().applyEvent("s1" as SessionId, {
      type: "runner-started",
      runnerId: "r1" as RunnerId,
      thinkingEffort: "high",
    })
    expect(store.getState().thinkingEffortBySession.s1).toBe("off")
  })
})

const sid2 = "s_1" as SessionId
const deps2 = {} as never // StoreDeps is unused by runViewStore

describe("runViewStore starting signal", () => {
  it("markStarting sets the flag and applyEvent clears it once the root runner starts", () => {
    const store = createRunViewStore(deps2)
    store.getState().markStarting(sid2)
    expect(store.getState().startingBySession[sid2]).toBe(true)
    store.getState().applyEvent(sid2, {
      type: "runner-started",
      runnerId: "r_root" as never,
    })
    expect(store.getState().startingBySession[sid2]).toBeUndefined()
    expect(store.getState().byId[sid2]?.rootRunnerId).toBe("r_root")
  })

  it("applyEvent clears starting on an errored runner-finished (start failure)", () => {
    const store = createRunViewStore(deps2)
    store.getState().markStarting(sid2)
    store.getState().applyEvent(sid2, {
      type: "runner-finished",
      runnerId: "r_root" as never,
      status: "errored",
      error: "boom",
    })
    expect(store.getState().startingBySession[sid2]).toBeUndefined()
  })

  it("reset drops the starting flag along with the session slice", () => {
    const store = createRunViewStore(deps2)
    store.getState().markStarting(sid2)
    store.getState().applyEvent(sid2, {
      type: "runner-started",
      runnerId: "r_root" as never,
    })
    store.getState().reset(sid2)
    expect(store.getState().byId[sid2]).toBeUndefined()
    expect(store.getState().startingBySession[sid2]).toBeUndefined()
  })
})
