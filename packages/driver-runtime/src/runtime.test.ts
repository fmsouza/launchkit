import { describe, expect, it } from "bun:test"
import type {
  CanonicalEvent,
  PermissionMode,
  QuestionAnswer,
  RunnerId,
} from "@spectrum/agent-events"
import type { ModelId } from "@spectrum/types"
import { createSequentialIdGen } from "@spectrum/utils"
import type { AdapterCtx, AdapterHandle, DriverAdapter } from "./adapter"
import { createDriver } from "./runtime"

const sync = (fn: () => void): void => fn()

// A controllable fake adapter: capture the ctx, resolve/reject start on demand, record handle calls.
const makeFakeAdapter = (): {
  adapter: DriverAdapter
  resolveStart: () => void
  rejectStart: (err: unknown) => void
  ctx: () => AdapterCtx
  sent: readonly string[]
  modes: readonly PermissionMode[]
  models: readonly string[]
  interrupts: number
  closes: number
} => {
  let resolve!: (h: AdapterHandle) => void
  let reject!: (e: unknown) => void
  let captured: AdapterCtx | undefined
  const sent: string[] = []
  const modes: PermissionMode[] = []
  const modelsSet: string[] = []
  const state = { interrupts: 0, closes: 0 }
  const handle: AdapterHandle = {
    send: (t) => {
      sent.push(t.text)
    },
    setMode: (mode) => {
      modes.push(mode)
    },
    setModel: (modelId) => {
      modelsSet.push(String(modelId))
    },
    interrupt: () => {
      state.interrupts += 1
    },
    close: () => {
      state.closes += 1
    },
  }
  const adapter: DriverAdapter = {
    start: (_input, ctx) => {
      captured = ctx
      return new Promise<AdapterHandle>((res, rej) => {
        resolve = res
        reject = rej
      })
    },
  }
  return {
    adapter,
    resolveStart: () => resolve(handle),
    rejectStart: (e) => reject(e),
    ctx: () => {
      if (captured === undefined) throw new Error("start not called")
      return captured
    },
    get sent() {
      return sent
    },
    get modes() {
      return modes
    },
    get models() {
      return modelsSet
    },
    get interrupts() {
      return state.interrupts
    },
    get closes() {
      return state.closes
    },
  }
}

const startInput = {
  harnessId: "claude" as never,
  cwd: "/tmp",
  env: {},
}

describe("createDriver", () => {
  it("returns ok(session) synchronously and exposes a minted root runner id", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    expect(started.ok).toBe(true)
    if (started.ok) expect(started.value.rootRunnerId).toBe("rnr_1" as RunnerId)
  })

  it("emits the events the adapter pushes via ctx.emit to the single subscriber", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    const seen: CanonicalEvent[] = []
    if (started.ok) started.value.onEvent((e) => seen.push(e))
    fake.ctx().emit({
      type: "runner-started",
      runnerId: fake.ctx().rootRunnerId,
      model: "claude-x",
    })
    expect(seen).toEqual([
      {
        type: "runner-started",
        runnerId: "rnr_1" as RunnerId,
        model: "claude-x",
      },
    ])
  })

  it("surfaces a startup failure as runner-finished errored on the root runner", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    const seen: CanonicalEvent[] = []
    if (started.ok) started.value.onEvent((e) => seen.push(e))
    fake.rejectStart(new Error("spawn failed"))
    // microtask flush for the rejected promise's .catch under the sync scheduler
    return Promise.resolve().then(() => {
      expect(seen).toEqual([
        {
          type: "runner-finished",
          runnerId: "rnr_1" as RunnerId,
          status: "errored",
          error: "Error: spawn failed",
        },
      ])
    })
  })

  it("marks the root runner started up front (prod timing: onEvent registered before the scheduled start runs)", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      // Defer like queueMicrotask: the subscriber registers before the scheduled startup runs.
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start(startInput)
    const seen: CanonicalEvent[] = []
    if (started.ok) started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen).toEqual([
      { type: "runner-started", runnerId: "rnr_1" as RunnerId },
    ])
  })

  it("a startup failure is now visible: root runner-started then runner-finished errored", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start(startInput)
    const seen: CanonicalEvent[] = []
    if (started.ok) started.value.onEvent((e) => seen.push(e))
    run?.()
    fake.rejectStart(new Error("spawn failed"))
    return Promise.resolve().then(() => {
      expect(seen).toEqual([
        { type: "runner-started", runnerId: "rnr_1" as RunnerId },
        {
          type: "runner-finished",
          runnerId: "rnr_1" as RunnerId,
          status: "errored",
          error: "Error: spawn failed",
        },
      ])
    })
  })

  it("queues send before the handle exists and drains it on start success", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // send BEFORE the adapter resolves → queued, not yet forwarded
    expect(started.value.send({ text: "hello" }).ok).toBe(true)
    expect(fake.sent).toEqual([])
    fake.resolveStart()
    await Promise.resolve()
    expect(fake.sent).toEqual(["hello"]) // drained into the handle
  })

  it("emits the user's turn as a role:user text-delta on the root runner when sending", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    started.value.send({ text: "do the thing" })
    expect(seen).toContainEqual({
      type: "text-delta",
      runnerId: "rnr_1" as RunnerId,
      messageId: "msg_2",
      text: "do the thing",
      role: "user",
    })
  })

  it("send emits a user text-delta whose attachments have no dataUrl, and forwards the full turn to the handle", async () => {
    const received: { text: string; attachments?: unknown }[] = []
    const adapter: DriverAdapter = {
      start: async () => ({
        send: (turn) => {
          received.push(turn)
        },
        interrupt: () => {},
        close: () => {},
      }),
    }
    const driver = createDriver({
      adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // flush the async adapter start promise so the handle exists
    await Promise.resolve()
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    started.value.send({
      text: "hi",
      attachments: [
        {
          id: "h1",
          mime: "image/png",
          displayName: "p.png",
          kind: "image",
          bytes: 4,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
    })
    // The handle received the full turn incl. dataUrl.
    expect(received[0]?.attachments).toEqual([
      expect.objectContaining({ dataUrl: "data:image/png;base64,AAAA" }),
    ])
    // The emitted text-delta carries refs WITHOUT dataUrl.
    const last = seen[seen.length - 1]
    expect(last).toBeDefined()
    if (last === undefined) throw new Error("expected an emitted event")
    expect(last.type).toBe("text-delta")
    const persistedAttachments = (last as { attachments?: unknown[] })
      .attachments
    expect(persistedAttachments).toBeDefined()
    expect(persistedAttachments).toHaveLength(1)
    const first = persistedAttachments?.[0] as { dataUrl?: unknown } | undefined
    expect(first?.dataUrl).toBeUndefined()
  })

  it("forwards send directly once the handle exists", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    fake.resolveStart()
    await Promise.resolve()
    started.value.send({ text: "second" })
    expect(fake.sent).toEqual(["second"])
  })

  it("resolves a pending requestApproval when respondApproval is called, emitting approval-resolved", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    const decisionP = fake.ctx().requestApproval(fake.ctx().rootRunnerId, {
      kind: "command",
      detail: "rm -rf x",
    })
    // requestApproval emitted approval-requested with a minted requestId (apr_2, since rnr_1 consumed _1)
    expect(seen).toEqual([
      {
        type: "approval-requested",
        runnerId: "rnr_1" as RunnerId,
        requestId: "apr_2",
        target: { kind: "command", detail: "rm -rf x" },
      },
    ])
    const r = started.value.respondApproval("apr_2", "allow")
    expect(r.ok).toBe(true)
    const decision = await decisionP
    expect(decision).toBe("allow")
    expect(seen[1]).toEqual({
      type: "approval-resolved",
      runnerId: "rnr_1" as RunnerId,
      requestId: "apr_2",
      decision: "allow",
      by: "user",
    })
  })

  it("treats respondApproval for an unknown requestId as a no-op ok", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    expect(started.value.respondApproval("apr_unknown", "deny").ok).toBe(true)
  })

  it("mints a fresh runner id from ctx.newRunnerId for sub-agents", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    driver.start(startInput)
    expect(fake.ctx().rootRunnerId).toBe("rnr_1" as RunnerId)
    expect(fake.ctx().newRunnerId()).toBe("rnr_2" as RunnerId)
  })

  it("forwards interrupt to the handle once it exists", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    fake.resolveStart()
    await Promise.resolve()
    started.value.interrupt()
    expect(fake.interrupts).toBe(1)
  })

  it("closes the handle and is idempotent (close twice → handle reaped exactly once)", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    fake.resolveStart()
    await Promise.resolve()
    expect(started.value.close().ok).toBe(true)
    expect(started.value.close().ok).toBe(true)
    expect(fake.closes).toBe(1) // handle reaped exactly once; second close is a no-op
  })

  it("(I2) close before the adapter start resolves still reaps the handle exactly once", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // close BEFORE the adapter's start promise resolves
    started.value.close()
    expect(fake.closes).toBe(0) // handle doesn't exist yet
    // now resolve start — runtime hits `if (closed) { h.close(); return }`
    fake.resolveStart()
    await Promise.resolve()
    expect(fake.closes).toBe(1) // handle reaped exactly once in the closed-flag guard
  })

  it("(M1) a second onEvent registration replaces the first subscriber", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const seen1: CanonicalEvent[] = []
    const seen2: CanonicalEvent[] = []
    started.value.onEvent((e) => seen1.push(e))
    started.value.onEvent((e) => seen2.push(e))
    // emit an event via the adapter ctx — only the second subscriber should receive it
    fake.ctx().emit({
      type: "runner-started",
      runnerId: fake.ctx().rootRunnerId,
      model: "claude-x",
    })
    expect(seen1).toEqual([]) // first subscriber was replaced
    expect(seen2).toHaveLength(1) // second subscriber received the event
  })

  it("(M2) ctx.emit with no subscriber registered drops silently and later onEvent does not replay it", () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // emit BEFORE any onEvent is registered — should not throw
    expect(() => {
      fake.ctx().emit({
        type: "runner-started",
        runnerId: fake.ctx().rootRunnerId,
        model: "claude-x",
      })
    }).not.toThrow()
    // now register a subscriber — the dropped event must NOT be replayed
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    expect(seen).toEqual([])
  })

  it("(M3) interrupt queued before the handle exists is drained exactly once on start resolve", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // interrupt BEFORE the adapter resolves → queued, not yet forwarded
    started.value.interrupt()
    expect(fake.interrupts).toBe(0)
    // resolve start — queue is drained into the handle
    fake.resolveStart()
    await Promise.resolve()
    expect(fake.interrupts).toBe(1)
  })

  it("emits supportedModes on the up-front runner-started when the adapter declares them", () => {
    const modes = ["manual", "plan"] as const
    const fake = makeFakeAdapter()
    // Override adapter with one that declares supportedModes
    const adapterWithModes: DriverAdapter = {
      ...fake.adapter,
      supportedModes: modes,
    }
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: adapterWithModes,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen[0]).toEqual({
      type: "runner-started",
      runnerId: "rnr_1" as RunnerId,
      supportedModes: ["manual", "plan"],
    })
  })

  it("emits permissionMode on the up-front runner-started when the start input carries one", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start({ ...startInput, permissionMode: "plan" })
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen[0]).toEqual({
      type: "runner-started",
      runnerId: "rnr_1" as RunnerId,
      permissionMode: "plan",
    })
  })

  it("omits supportedModes when the adapter does not declare them", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen[0]).toEqual({
      type: "runner-started",
      runnerId: "rnr_1" as RunnerId,
    })
  })

  it("queues setMode until the handle exists, then forwards to the adapter", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // setMode BEFORE the adapter resolves → queued, not yet forwarded
    started.value.setMode?.("bypass")
    expect(fake.modes).toEqual([])
    // resolve start — queue is drained into the handle
    fake.resolveStart()
    await Promise.resolve()
    expect(fake.modes).toEqual(["bypass"])
  })

  it("forwards setMode immediately once the handle exists", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    // resolve start first
    fake.resolveStart()
    await Promise.resolve()
    // setMode AFTER handle exists → forwarded immediately
    started.value.setMode?.("plan")
    expect(fake.modes).toEqual(["plan"])
  })

  it("emits model on the up-front runner-started when the start input carries one", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start({ ...startInput, modelId: "mdl_x" as never })
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen[0]).toEqual({
      type: "runner-started",
      runnerId: "rnr_1" as RunnerId,
      model: "mdl_x",
    })
  })

  it("queues setModel until the handle exists, then forwards to the adapter", async () => {
    const fake = makeFakeAdapter()
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    started.value.setModel?.("mdl_y" as never)
    expect(fake.models).toEqual([]) // queued before the handle exists
    fake.resolveStart()
    await Promise.resolve()
    expect(fake.models).toEqual(["mdl_y"]) // drained into the handle
  })

  it("forwards the env argument to the adapter handle when setModel is called", async () => {
    const calls: Array<{
      modelId: string
      env: Readonly<Record<string, string>> | undefined
    }> = []
    const adapter: DriverAdapter = {
      supportedModes: ["manual"],
      start: async () => ({
        send: () => {},
        interrupt: () => {},
        close: () => {},
        setModel: (modelId, env) =>
          calls.push({ modelId: String(modelId), env }),
      }),
    }
    const driver = createDriver({
      adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    // flush the async adapter start promise before calling setModel so the handle exists
    await Promise.resolve()
    started.value.setModel?.("mdl_x" as ModelId, { ANTHROPIC_MODEL: "mdl_x" })
    expect(calls).toEqual([
      { modelId: "mdl_x", env: { ANTHROPIC_MODEL: "mdl_x" } },
    ])
  })

  describe("createDriver reportResumeToken", () => {
    it("forwards adapter's reportResumeToken calls to deps.setResumeId bound to the current session id", () => {
      const calls: Array<{ sessionId: string; resumeId: string }> = []
      const fake = makeFakeAdapter()
      const driver = createDriver({
        adapter: fake.adapter,
        idGen: createSequentialIdGen(),
        scheduler: sync,
        setResumeId: (sessionId, resumeId) => {
          calls.push({ sessionId, resumeId })
        },
      })
      driver.start({
        ...startInput,
        sessionId: "sess_abc" as never,
      })
      // Adapter calls ctx.reportResumeToken once it learns its native id.
      fake.ctx().reportResumeToken?.("native-1")
      expect(calls).toEqual([{ sessionId: "sess_abc", resumeId: "native-1" }])
    })

    it("does not place reportResumeToken on ctx when deps.setResumeId is undefined", () => {
      const fake = makeFakeAdapter()
      const driver = createDriver({
        adapter: fake.adapter,
        idGen: createSequentialIdGen(),
        scheduler: sync,
      })
      driver.start({
        ...startInput,
        sessionId: "sess_abc" as never,
      })
      expect(fake.ctx().reportResumeToken).toBeUndefined()
    })

    it("does not place reportResumeToken on ctx when input.sessionId is undefined", () => {
      const calls: Array<{ sessionId: string; resumeId: string }> = []
      const fake = makeFakeAdapter()
      const driver = createDriver({
        adapter: fake.adapter,
        idGen: createSequentialIdGen(),
        scheduler: sync,
        setResumeId: (sessionId, resumeId) => {
          calls.push({ sessionId, resumeId })
        },
      })
      driver.start(startInput)
      expect(fake.ctx().reportResumeToken).toBeUndefined()
    })
  })

  it("forwards setThinkingEffort to the adapter handle (queued before start)", async () => {
    const calls: string[] = []
    const adapter: DriverAdapter = {
      start: async () => ({
        send: () => {},
        interrupt: () => {},
        close: () => {},
        setThinkingEffort: (e) => {
          calls.push(e)
        },
      }),
    }
    const driver = createDriver({
      adapter,
      idGen: createSequentialIdGen(),
      scheduler: sync,
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const session = started.value
    session.setThinkingEffort?.("medium")
    await Promise.resolve()
    expect(calls).toEqual(["medium"])
  })

  it("emits thinkingEffort on the up-front runner-started when the start input carries one", () => {
    const fake = makeFakeAdapter()
    let run: (() => void) | undefined
    const driver = createDriver({
      adapter: fake.adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => {
        run = fn
      },
    })
    const started = driver.start({ ...startInput, thinkingEffort: "high" })
    if (!started.ok) throw new Error("expected ok")
    const seen: CanonicalEvent[] = []
    started.value.onEvent((e) => seen.push(e))
    run?.()
    expect(seen[0]).toEqual({
      type: "runner-started",
      runnerId: "rnr_1" as RunnerId,
      thinkingEffort: "high",
    })
  })

  it("emits question-requested and resolves requestQuestion on respondQuestion", async () => {
    const events: CanonicalEvent[] = []
    let resolved: QuestionAnswer | undefined
    const adapter: DriverAdapter = {
      start: async (_input, ctx) => {
        // Defer requestQuestion so it fires after onEvent is registered (mirrors real usage
        // where a harness sends a question after first output, not during its start).
        await Promise.resolve()
        void ctx
          .requestQuestion(ctx.rootRunnerId, {
            questions: [
              {
                question: "Q?",
                header: "H",
                options: [],
                multiSelect: false,
                allowFreeText: true,
              },
            ],
          })
          .then((a) => {
            resolved = a
          })
        return { send() {}, interrupt() {}, close() {} }
      },
    }
    const driver = createDriver({
      adapter,
      idGen: createSequentialIdGen(),
      scheduler: (fn) => fn(),
    })
    const started = driver.start(startInput)
    if (!started.ok) throw new Error("expected ok")
    const session = started.value
    session.onEvent((e: CanonicalEvent) => events.push(e))
    // flush: adapter.start resolves → requestQuestion emits question-requested
    await Promise.resolve()
    await Promise.resolve()
    const req = events.find((e) => e.type === "question-requested")
    expect(req).toBeDefined()
    if (req === undefined || req.type !== "question-requested")
      throw new Error("expected question-requested")
    const answer: QuestionAnswer = {
      selections: [{ questionIndex: 0, labels: ["A"] }],
    }
    session.respondQuestion(req.requestId, answer)
    await Promise.resolve()
    expect(resolved).toEqual(answer)
    expect(events.some((e) => e.type === "question-resolved")).toBe(true)
  })
})
