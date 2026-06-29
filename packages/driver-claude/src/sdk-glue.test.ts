import { describe, expect, it } from "bun:test"
import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  CanonicalEvent,
  QuestionAnswer,
  RunnerId,
} from "@spectrum/agent-events"
import type { AdapterCtx } from "@spectrum/driver-runtime"
import type { Logger } from "@spectrum/logger"
import { createClaudeAdapter } from "./sdk-glue"
import type { ClaudeQuery, ClaudeSdk, SdkOptions } from "./sdk-glue"
import type { SdkMessageLike } from "./sdk-types"

// --- recording fake Logger ---------------------------------------------------------------
interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error" | "fatal"
  readonly msg: string
  readonly fields: Record<string, unknown> | undefined
}

const makeRecordingLogger = (): {
  logger: Logger
  entries: LogEntry[]
} => {
  const entries: LogEntry[] = []
  const record = (
    level: LogEntry["level"],
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    entries.push({ level, msg, fields })
  }
  const logger: Logger = {
    debug: (msg: string, fields?: Record<string, unknown>) =>
      record("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) =>
      record("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      record("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) =>
      record("error", msg, fields),
    fatal: (msg: string, fields?: Record<string, unknown>) =>
      record("fatal", msg, fields),
    child: (_scope: string, _fields?: Record<string, unknown>) => logger,
  }
  return { logger, entries }
}

// --- a controllable fake query ----------------------------------------------------------
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const makeFakeSdk = (
  scripted: readonly unknown[],
): {
  sdk: ClaudeSdk
  capturedOptions: () => SdkOptions
  interrupts: number
  closes: number
  pushedPrompts: readonly unknown[]
  setPermissionModeCalls: readonly string[]
} => {
  let options: SdkOptions | undefined
  const state = { interrupts: 0, closes: 0 }
  const pushed: unknown[] = []
  const setPermissionModeCalls: string[] = []
  const done = defer<void>()

  const query = (args: {
    prompt: AsyncIterable<unknown>
    options?: SdkOptions
  }): ClaudeQuery => {
    options = args.options
    // Drain the streaming-input prompt in the background to capture follow-ups.
    void (async () => {
      for await (const m of args.prompt) pushed.push(m)
    })()
    const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
      for (const msg of scripted) yield msg as SdkMessageLike
      await done.promise // block like a live session until closed
    })()
    const q: ClaudeQuery = Object.assign(iterator, {
      interrupt: async () => {
        state.interrupts += 1
      },
      close: () => {
        state.closes += 1
        done.resolve()
      },
      setPermissionMode: async (mode: string) => {
        setPermissionModeCalls.push(mode)
      },
    })
    return q
  }

  return {
    sdk: { query },
    capturedOptions: () => {
      if (options === undefined) throw new Error("query not called")
      return options
    },
    get interrupts() {
      return state.interrupts
    },
    get closes() {
      return state.closes
    },
    get pushedPrompts() {
      return pushed
    },
    get setPermissionModeCalls() {
      return setPermissionModeCalls
    },
  }
}

// --- multi-query fake SDK for restart tests ---------------------------------------------
/** Per-query record captured by the multi-query fake. */
interface QueryRecord {
  options: SdkOptions | undefined
  pushedPrompts: unknown[]
  closes: number
  setPermissionModeCalls: string[]
  /** Resolve to unblock the query iterator (simulates close). */
  unblock: () => void
  /** Push a message into the query's scripted stream (post-creation). */
  pushMsg: (msg: SdkMessageLike) => void
}

/**
 * A multi-query fake SDK that records every `query()` call independently.
 * Each call gets its own record so tests can assert on the second (restart) query.
 *
 * `setPermissionModeBehavior` controls what `setPermissionMode` does:
 *   - `"resolve"` → the call resolves normally (in-place switch)
 *   - `"reject"`  → the call rejects with the bypass-permissions error
 *   - `"absent"`  → `setPermissionMode` is not present on the query object
 *
 * `throwOnClose` — when true, closing/aborting the query's iterator throws an
 * AbortError-like error instead of completing cleanly (simulates the real SDK
 * throwing when the abort controller fires while the `for await` is running).
 */
const makeMultiQueryFakeSdk = (
  setPermissionModeBehavior: "resolve" | "reject" | "absent",
  throwOnClose = false,
): {
  sdk: ClaudeSdk
  queries: QueryRecord[]
} => {
  const queries: QueryRecord[] = []

  const query = (args: {
    prompt: AsyncIterable<unknown>
    options?: SdkOptions
  }): ClaudeQuery => {
    const done = defer<void>()
    const msgQueue: SdkMessageLike[] = []
    let msgWake: (() => void) | null = null
    let shouldThrow = false

    const record: QueryRecord = {
      options: args.options,
      pushedPrompts: [],
      closes: 0,
      setPermissionModeCalls: [],
      unblock: () => done.resolve(),
      pushMsg: (msg) => {
        msgQueue.push(msg)
        msgWake?.()
        msgWake = null
      },
    }
    queries.push(record)

    // Drain the streaming-input prompt.
    void (async () => {
      for await (const m of args.prompt) record.pushedPrompts.push(m)
    })()

    const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
      while (true) {
        while (msgQueue.length > 0) {
          const msg = msgQueue.shift()
          if (msg !== undefined) yield msg
        }
        // Race: either a new message arrives or done resolves.
        const raceWake = new Promise<void>((r) => {
          msgWake = r
        })
        // If done already resolved, stop or throw.
        let finished = false
        done.promise.then(() => {
          finished = true
          msgWake?.()
          msgWake = null
        })
        await raceWake
        if (finished && msgQueue.length === 0) {
          if (shouldThrow) {
            throw new Error("AbortError: The operation was aborted.")
          }
          break
        }
      }
    })()

    const setPermissionMode =
      setPermissionModeBehavior === "absent"
        ? undefined
        : async (mode: string) => {
            record.setPermissionModeCalls.push(mode)
            if (setPermissionModeBehavior === "reject") {
              throw new Error(
                "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
              )
            }
          }

    const q: ClaudeQuery = Object.assign(iterator, {
      interrupt: async () => {},
      close: () => {
        record.closes += 1
        if (throwOnClose) shouldThrow = true
        done.resolve()
      },
      ...(setPermissionMode !== undefined ? { setPermissionMode } : {}),
    })
    return q
  }

  return { sdk: { query }, queries }
}

const ROOT = "rnr_root" as RunnerId
const makeCtx = (
  emitted: CanonicalEvent[],
  approvals: Array<{
    runnerId: RunnerId
    resolve: (d: "allow" | "deny") => void
  }>,
  questions?: Array<{
    runnerId: RunnerId
    requestId: string
    resolve: (a: QuestionAnswer) => void
  }>,
): AdapterCtx => ({
  rootRunnerId: ROOT,
  emit: (e) => emitted.push(e),
  newRunnerId: () => "rnr_child" as RunnerId,
  requestApproval: (runnerId) =>
    new Promise((resolve) => approvals.push({ runnerId, resolve })),
  requestQuestion: (runnerId, prompt) =>
    new Promise((resolve) => {
      const requestId = `qreq_${questions?.length ?? 0}`
      emitted.push({
        type: "question-requested",
        runnerId,
        requestId,
        prompt,
      } as CanonicalEvent)
      questions?.push({ runnerId, requestId, resolve })
    }),
})

const input: AgentStartInput = {
  harnessId: "claude" as never,
  cwd: "/work",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
    ANTHROPIC_AUTH_TOKEN: "k",
  },
}

describe("createClaudeAdapter", () => {
  it("passes the proxy env + cwd into the SDK query options", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))
    const opts = fake.capturedOptions()
    expect(opts.env).toEqual(input.env)
    expect(opts.cwd).toBe("/work")
  })

  it("merges baseEnv UNDER input.env so claude inherits PATH/HOME but the proxy env wins", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      baseEnv: () => ({
        PATH: "/usr/bin",
        HOME: "/home/me",
        ANTHROPIC_BASE_URL: "stale-should-be-overridden",
      }),
    })
    await adapter.start(input, makeCtx([], []))
    const env = fake.capturedOptions().env ?? {}
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/me")
    // input.env (the per-run proxy vars) wins over the inherited base env
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("k")
  })

  it("passes input.command as pathToClaudeCodeExecutable (the SDK's bundle-relative default is unusable when packaged)", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(
      { ...input, command: "/abs/bin/claude" },
      makeCtx([], []),
    )
    expect(fake.capturedOptions().pathToClaudeCodeExecutable).toBe(
      "/abs/bin/claude",
    )
  })

  it("falls back to deps.pathToClaudeExecutable when input.command is absent", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      pathToClaudeExecutable: "/dep/claude",
    })
    await adapter.start(input, makeCtx([], []))
    expect(fake.capturedOptions().pathToClaudeCodeExecutable).toBe(
      "/dep/claude",
    )
  })

  it("pumps each yielded SDK message through mapClaudeMessage into ctx.emit", async () => {
    const fake = makeFakeSdk([
      { type: "system", subtype: "init", model: "claude-x" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ])
    const emitted: CanonicalEvent[] = []
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx(emitted, []))
    // allow the background pump to drain the scripted messages
    await new Promise((r) => setTimeout(r, 10))
    expect(emitted[0]).toEqual({
      type: "runner-started",
      runnerId: ROOT,
      model: "claude-x",
    })
    expect(emitted[1]).toMatchObject({
      type: "text-delta",
      runnerId: ROOT,
      text: "hi",
    })
  })

  it("routes canUseTool through ctx.requestApproval and returns allow/deny as a PermissionResult", async () => {
    const fake = makeFakeSdk([])
    const approvals: Array<{
      runnerId: RunnerId
      resolve: (d: "allow" | "deny") => void
    }> = []
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], approvals))
    const canUseTool = fake.capturedOptions().canUseTool
    if (canUseTool === undefined) throw new Error("canUseTool not set")
    const resultP = canUseTool(
      "Bash",
      { command: "rm -rf build" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    )
    // it asked for approval against the root runner with a command target
    expect(approvals).toHaveLength(1)
    approvals[0]?.resolve("allow")
    // The SDK requires `updatedInput` on allow — we echo the original tool input unchanged.
    await expect(resultP).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf build" },
    })

    const denyP = canUseTool(
      "Bash",
      { command: "rm -rf /" },
      { signal: new AbortController().signal, toolUseID: "toolu_2" },
    )
    approvals[1]?.resolve("deny")
    await expect(denyP).resolves.toMatchObject({ behavior: "deny" })
  })

  it("routes AskUserQuestion through ctx.requestQuestion and returns allow with updatedInput answers", async () => {
    const fake = makeFakeSdk([])
    const emitted: CanonicalEvent[] = []
    const approvals: Array<{
      runnerId: RunnerId
      resolve: (d: "allow" | "deny") => void
    }> = []
    const questions: Array<{
      runnerId: RunnerId
      requestId: string
      resolve: (a: QuestionAnswer) => void
    }> = []
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx(emitted, approvals, questions))

    const canUseTool = fake.capturedOptions().canUseTool
    if (canUseTool === undefined) throw new Error("canUseTool not set")

    const toolInput = {
      questions: [
        {
          question: "Which library?",
          header: "Library",
          options: [{ label: "date-fns", description: "lightweight" }],
          multiSelect: false,
        },
      ],
    }

    const resultP = canUseTool("AskUserQuestion", toolInput, {
      signal: new AbortController().signal,
      toolUseID: "t1",
    })

    // Allow requestQuestion to be called and emit the question-requested event
    await Promise.resolve()

    // A question-requested event must have been emitted, NO approval-requested
    const questionReq = emitted.find((e) => e.type === "question-requested")
    expect(questionReq).toBeDefined()
    expect(approvals).toHaveLength(0)

    // Resolve the pending question
    questions[0]?.resolve({
      selections: [{ questionIndex: 0, labels: ["date-fns"] }],
    })

    const result = await resultP
    expect(result).toMatchObject({ behavior: "allow" })
    const allowResult = result as {
      behavior: "allow"
      updatedInput: { answers: Record<string, string> }
    }
    expect(allowResult.updatedInput.answers["Which library?"]).toBe("date-fns")
  })

  it("denies AskUserQuestion when the signal is already aborted", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))

    const canUseTool = fake.capturedOptions().canUseTool
    if (canUseTool === undefined) throw new Error("canUseTool not set")

    const abort = new AbortController()
    abort.abort()

    const toolInput = {
      questions: [
        {
          question: "Which library?",
          header: "Library",
          options: [{ label: "date-fns", description: "lightweight" }],
          multiSelect: false,
        },
      ],
    }

    const result = await canUseTool("AskUserQuestion", toolInput, {
      signal: abort.signal,
      toolUseID: "t2",
    })
    expect(result).toMatchObject({ behavior: "deny" })
  })

  it("denies AskUserQuestion when the input is malformed", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))

    const canUseTool = fake.capturedOptions().canUseTool
    if (canUseTool === undefined) throw new Error("canUseTool not set")

    const result = await canUseTool(
      "AskUserQuestion",
      { nope: 1 },
      { signal: new AbortController().signal, toolUseID: "t3" },
    )
    expect(result).toEqual({ behavior: "deny", message: expect.any(String) })
  })

  it("send pushes a user message into the streaming-input prompt", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.send("follow up")
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.pushedPrompts).toContainEqual({
      type: "user",
      message: { role: "user", content: "follow up" },
      parent_tool_use_id: null,
    })
  })

  it("interrupt calls query.interrupt and close ends the query (idempotent)", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.interrupt()
    expect(fake.interrupts).toBe(1)
    handle.close()
    handle.close()
    expect(fake.closes).toBe(1)
  })

  it("passes the normalized permissionMode to the SDK query options (plan → 'plan')", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start({ ...input, permissionMode: "plan" }, makeCtx([], []))
    expect(fake.capturedOptions().permissionMode).toBe("plan")
  })

  it("handle.setMode calls query.setPermissionMode with the mapped SDK string", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.setMode?.("bypass")
    // setPermissionMode is async/fire-and-forget; wait a tick for the promise to settle
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.setPermissionModeCalls).toEqual(["bypassPermissions"])
  })

  // --- Task 11: resume via input.resume + reportResumeToken on system:init ----------------

  it("passes input.resume to the initial sdk.query options", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start({ ...input, resume: "claude-7" }, makeCtx([], []))
    expect(fake.capturedOptions().resume).toBe("claude-7")
  })

  it("reports the claude session id via ctx.reportResumeToken on system:init", async () => {
    const reported: string[] = []
    const fake = makeFakeSdk([
      { type: "system", subtype: "init", model: "m", session_id: "claude-7" },
      { type: "result", subtype: "success" },
    ])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    const ctx = makeCtx([], [])
    ctx.reportResumeToken = (t) => reported.push(t)
    await adapter.start(input, ctx)
    // allow the pump microtask to run
    await new Promise((r) => setTimeout(r, 10))
    expect(reported).toEqual(["claude-7"])
  })

  // --- restart-on-rejection tests ---------------------------------------------------------

  it("restarts the query with resume and the new mode when setPermissionMode rejects", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("reject")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const emitted: CanonicalEvent[] = []
    const handle = await adapter.start(input, makeCtx(emitted, []))

    // Push an init message so the glue captures the claude session id.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_abc",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setMode?.("bypass")
    // Allow the rejection handler microtask to run, then the restart to happen.
    await new Promise((r) => setTimeout(r, 20))

    // Two query() calls: the original and the restarted one.
    expect(queries).toHaveLength(2)
    // Second call carries the new permissionMode and the captured session id.
    expect(queries[1]?.options?.permissionMode).toBe("bypassPermissions")
    expect(queries[1]?.options?.resume).toBe("sess_abc")
    // No runner-finished errored event must have been emitted during the restart.
    const erroredEvents = emitted.filter(
      (e) => e.type === "runner-finished" && e.status === "errored",
    )
    expect(erroredEvents).toHaveLength(0)
  })

  it("switches in place when setPermissionMode resolves", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    handle.setMode?.("plan")
    await new Promise((r) => setTimeout(r, 10))

    // Only one query() call — no restart happened.
    expect(queries).toHaveLength(1)
    expect(queries[0]?.setPermissionModeCalls).toEqual(["plan"])
  })

  it("routes send to the new input stream after a restart", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("reject")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_xyz",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setMode?.("bypass")
    await new Promise((r) => setTimeout(r, 20))

    // After restart, send should go to the second query's input stream.
    handle.send("hi after restart")
    await new Promise((r) => setTimeout(r, 10))

    expect(queries).toHaveLength(2)
    const secondPrompts = queries[1]?.pushedPrompts ?? []
    expect(secondPrompts).toContainEqual({
      type: "user",
      message: { role: "user", content: "hi after restart" },
      parent_tool_use_id: null,
    })
  })

  it("restarts immediately when the SDK has no setPermissionMode", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("absent")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    handle.setMode?.("bypass")
    await new Promise((r) => setTimeout(r, 10))

    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.permissionMode).toBe("bypassPermissions")
  })

  // --- Finding 1: stale-pump race ---------------------------------------------------------

  it("does not emit errored when the old query throws on teardown during a restart", async () => {
    // throwOnClose=true: the first query's iterator throws an AbortError-like error
    // when close() fires, simulating the real SDK behaviour.
    const { sdk, queries } = makeMultiQueryFakeSdk("reject", true)
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const emitted: CanonicalEvent[] = []
    const handle = await adapter.start(input, makeCtx(emitted, []))

    // Capture the session id so restart can resume.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_throw",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setMode?.("bypass")
    // Give the rejection handler, the restart, AND the old pump's catch time to all run.
    await new Promise((r) => setTimeout(r, 30))

    // There must be NO runner-finished errored event — the throw came from teardown.
    const erroredEvents = emitted.filter(
      (e) => e.type === "runner-finished" && e.status === "errored",
    )
    expect(erroredEvents).toHaveLength(0)
    // And we still got a second query (the restart happened).
    expect(queries).toHaveLength(2)
  })

  // --- Finding 2: setMode before session id is known -------------------------------------

  it("defers the restart until the session id is known", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("reject")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    // Call setMode BEFORE system:init has been received (claudeSessionId === undefined).
    handle.setMode?.("bypass")
    await new Promise((r) => setTimeout(r, 20))

    // Should NOT have launched a second query yet — we can't resume without a session id.
    expect(queries).toHaveLength(1)

    // Now deliver the init message so the glue captures the session id.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_deferred",
    })
    await new Promise((r) => setTimeout(r, 30))

    // NOW the deferred restart should have fired with resume + the new mode.
    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.permissionMode).toBe("bypassPermissions")
    expect(queries[1]?.options?.resume).toBe("sess_deferred")
  })

  // --- setModel: resume-restart with new model -------------------------------------------

  it("setModel relaunches the query with the new model, resuming the claude session", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    // Push an init message so the glue captures the claude session id.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_mdl",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setModel?.("mdl_new" as never)
    // setModel is synchronous (relaunches immediately); allow the restart to happen.
    await new Promise((r) => setTimeout(r, 20))

    // Two query() calls: the original and the relaunched one.
    expect(queries).toHaveLength(2)
    // Second call carries the new model and the captured session id (resume).
    expect(queries[1]?.options?.model).toBe("mdl_new")
    expect(queries[1]?.options?.resume).toBe("sess_mdl")
  })

  it("relaunches with the new env and model when setModel is called with an env", async () => {
    const launchedEnvs: Array<Record<string, string | undefined>> = []
    const fakeSdk: ClaudeSdk = {
      query: (args) => {
        launchedEnvs.push({ ...(args.options?.env ?? {}) })
        // Build a minimal multi-query compatible fake: async-iterable that blocks until closed.
        const done = { resolve: (): void => {} }
        const doneP = new Promise<void>((r) => {
          done.resolve = r
        })
        const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
          // Yield a system:init so the glue captures the session id.
          yield {
            type: "system",
            subtype: "init",
            model: "m",
            session_id: "sess_env_test",
          } as SdkMessageLike
          await doneP
        })()
        const q: ClaudeQuery = Object.assign(iterator, {
          interrupt: async () => {},
          close: () => {
            done.resolve()
          },
        })
        return q
      },
    }
    const adapter = createClaudeAdapter({ loadSdk: async () => fakeSdk })
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {},
      },
      makeCtx([], []),
    )
    // Allow the first query's system:init to be processed (capturing the session id).
    await new Promise((r) => setTimeout(r, 20))
    handle.setModel?.("mdl_x" as never, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_MODEL: "mdl_x",
    })
    // Allow the restart to happen.
    await new Promise((r) => setTimeout(r, 20))
    const last = launchedEnvs.at(-1)
    expect(last?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000")
    expect(last?.ANTHROPIC_MODEL).toBe("mdl_x")
  })

  it("setModel does not emit errored when the old query throws on teardown", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve", true)
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const emitted: CanonicalEvent[] = []
    const handle = await adapter.start(input, makeCtx(emitted, []))

    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_mdl_throw",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setModel?.("mdl_newer" as never)
    // Give the restart, AND the old pump's catch time to all run.
    await new Promise((r) => setTimeout(r, 30))

    const erroredEvents = emitted.filter(
      (e) => e.type === "runner-finished" && e.status === "errored",
    )
    expect(erroredEvents).toHaveLength(0)
    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.model).toBe("mdl_newer")
    expect(queries[1]?.options?.resume).toBe("sess_mdl_throw")
  })

  // --- setModel(null): clear model and drop proxy env -------------------------------------

  it("clears the model and drops proxy env when setModel is called with null", async () => {
    const launched: Array<{
      model: string | undefined
      env: Record<string, string | undefined>
    }> = []
    const fakeSdk: ClaudeSdk = {
      query: ({ options }) => {
        launched.push({
          model: options?.model,
          env: { ...(options?.env ?? {}) },
        })
        // Minimal inline fake: async-iterable that blocks until closed.
        const done = { resolve: (): void => {} }
        const doneP = new Promise<void>((r) => {
          done.resolve = r
        })
        const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
          yield {
            type: "system",
            subtype: "init",
            model: "m",
            session_id: "sess_null_test",
          } as SdkMessageLike
          await doneP
        })()
        const q: ClaudeQuery = Object.assign(iterator, {
          interrupt: async () => {},
          close: () => {
            done.resolve()
          },
        })
        return q
      },
    }
    const adapter = createClaudeAdapter({ loadSdk: async () => fakeSdk })
    // Launch PROXIED first (has a model + proxy env), then switch to default (null).
    const handle = await adapter.start(
      {
        harnessId: "claude" as never,
        cwd: "/tmp",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
          ANTHROPIC_MODEL: "mdl_x",
        },
        modelId: "mdl_x" as never,
      },
      makeCtx([], []),
    )
    // Allow the first query's system:init to be processed (capturing the session id).
    await new Promise((r) => setTimeout(r, 20))
    handle.setModel?.(null, {})
    // Allow the restart to happen.
    await new Promise((r) => setTimeout(r, 20))
    const last = launched.at(-1)
    expect(last?.model).toBeUndefined()
    expect(last?.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(last?.env.ANTHROPIC_MODEL).toBeUndefined()
  })

  // --- observability: logger + stderr + watchdog ------------------------------------------

  it("wires stderr to the logger as a warn log with truncated chunk", async () => {
    const { logger, entries } = makeRecordingLogger()
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    await adapter.start(input, makeCtx([], []))
    const stderrHandler = fake.capturedOptions().stderr
    if (stderrHandler === undefined) throw new Error("stderr not wired")
    stderrHandler("boom from claude")
    const warnEntry = entries.find(
      (e) => e.level === "warn" && e.msg === "claude stderr",
    )
    expect(warnEntry).toBeDefined()
    expect(warnEntry?.fields?.chunk).toContain("boom from claude")
  })

  it("logs lifecycle events: adapter starting and sdk loaded", async () => {
    const { logger, entries } = makeRecordingLogger()
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    await adapter.start(input, makeCtx([], []))
    const startingEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude adapter starting",
    )
    const loadedEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude sdk loaded",
    )
    expect(startingEntry).toBeDefined()
    expect(loadedEntry).toBeDefined()
  })

  it("logs claude turn -> sdk input with the text length when send is called", async () => {
    const { logger, entries } = makeRecordingLogger()
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.send("hello")
    const turnEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude turn -> sdk input",
    )
    expect(turnEntry).toBeDefined()
    expect(turnEntry?.fields?.length).toBe(5)
  })

  it("logs the first sdk message exactly once even when multiple messages arrive", async () => {
    const { logger, entries } = makeRecordingLogger()
    const fake = makeFakeSdk([
      { type: "system", subtype: "init", model: "claude-x" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    await adapter.start(input, makeCtx([], []))
    // Allow the background pump to drain the scripted messages
    await new Promise((r) => setTimeout(r, 20))
    const firstMsgEntries = entries.filter(
      (e) => e.level === "info" && e.msg === "claude first sdk message",
    )
    expect(firstMsgEntries).toHaveLength(1)
    expect(firstMsgEntries[0]?.fields?.type).toBe("system")
  })

  it("fires the no-response watchdog warn when the timer fires before any sdk message", async () => {
    const { logger, entries } = makeRecordingLogger()
    // A scripted SDK that never yields anything (blocked on a deferred)
    const block = defer<void>()
    const emptySdk: ClaudeSdk = {
      query: (args) => {
        void (async () => {
          for await (const _ of args.prompt) {
            // drain
          }
        })()
        const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
          await block.promise
          // never reached — generator is intentionally empty; yield satisfies lint rule
          if (false as boolean) yield {} as SdkMessageLike
        })()
        return Object.assign(iterator, {
          interrupt: async () => {},
          close: () => {
            block.resolve()
          },
        })
      },
    }

    let capturedCallback: (() => void) | undefined
    const setTimer = (fn: () => void, _ms: number): (() => void) => {
      capturedCallback = fn
      return () => {
        capturedCallback = undefined
      }
    }

    const adapter = createClaudeAdapter({
      loadSdk: async () => emptySdk,
      logger,
      setTimer,
      responseTimeoutMs: 30000,
    })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.send("x")
    // Fire the watchdog manually (no real timer)
    capturedCallback?.()
    const warnEntry = entries.find(
      (e) =>
        e.level === "warn" &&
        e.msg === "claude: no sdk response within timeout",
    )
    expect(warnEntry).toBeDefined()
    handle.close()
  })

  it("does NOT fire the watchdog warn when an sdk message arrives before the timer fires", async () => {
    const { logger, entries } = makeRecordingLogger()
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")

    let capturedCallback: (() => void) | undefined
    const setTimer = (fn: () => void, _ms: number): (() => void) => {
      capturedCallback = fn
      return () => {
        capturedCallback = undefined
      }
    }

    const adapter = createClaudeAdapter({
      loadSdk: async () => sdk,
      logger,
      setTimer,
    })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.send("x")
    // Push a message so the pump sees it (arms disarm)
    queries[0]?.pushMsg({ type: "system", subtype: "init", model: "m" })
    await new Promise((r) => setTimeout(r, 10))
    // Now fire the timer callback — watchdog should have been cancelled
    capturedCallback?.()
    const warnEntry = entries.find(
      (e) =>
        e.level === "warn" &&
        e.msg === "claude: no sdk response within timeout",
    )
    expect(warnEntry).toBeUndefined()
    handle.close()
  })

  // --- per-turn watchdog re-arm + completion logging (new in observability-turns) ----------

  it("re-arms the watchdog on the second turn when the first response arrived", async () => {
    // With OLD one-shot logic this would NOT fire the warn on the second turn — that's RED.
    const { logger, entries } = makeRecordingLogger()
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")

    const timerCallbacks: Array<() => void> = []
    const cancelFns: Array<() => void> = []
    const setTimer = (fn: () => void, _ms: number): (() => void) => {
      timerCallbacks.push(fn)
      const cancel = (): void => {
        // Remove from timerCallbacks so it can't be fired after disarm
        const idx = timerCallbacks.indexOf(fn)
        if (idx !== -1) timerCallbacks.splice(idx, 1)
        cancelFns.push(cancel)
      }
      return cancel
    }

    const adapter = createClaudeAdapter({
      loadSdk: async () => sdk,
      logger,
      setTimer,
    })
    const handle = await adapter.start(input, makeCtx([], []))

    // Turn 1: send and have the SDK respond — disarms the turn-1 watchdog
    handle.send("turn 1")
    queries[0]?.pushMsg({ type: "system", subtype: "init", model: "m" })
    await new Promise((r) => setTimeout(r, 10))

    // Turn 2: send with NO further messages scripted
    handle.send("turn 2")
    // Fire the timer that was armed for turn 2
    const turn2Timer = timerCallbacks[timerCallbacks.length - 1]
    turn2Timer?.()

    const warnEntry = entries.find(
      (e) =>
        e.level === "warn" &&
        e.msg === "claude: no sdk response within timeout",
    )
    expect(warnEntry).toBeDefined()
    handle.close()
  })

  it("does NOT fire the watchdog warn when response arrives before the timer fires (disarm on any message)", async () => {
    const { logger, entries } = makeRecordingLogger()
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")

    let capturedCallback: (() => void) | undefined
    const setTimer = (fn: () => void, _ms: number): (() => void) => {
      capturedCallback = fn
      return () => {
        capturedCallback = undefined
      }
    }

    const adapter = createClaudeAdapter({
      loadSdk: async () => sdk,
      logger,
      setTimer,
    })
    const handle = await adapter.start(input, makeCtx([], []))
    handle.send("hello")
    // Push a message so the pump disarms the watchdog
    queries[0]?.pushMsg({ type: "system", subtype: "init", model: "m" })
    await new Promise((r) => setTimeout(r, 10))
    // Fire the timer — should NOT warn (already disarmed)
    capturedCallback?.()
    const warnEntry = entries.find(
      (e) =>
        e.level === "warn" &&
        e.msg === "claude: no sdk response within timeout",
    )
    expect(warnEntry).toBeUndefined()
    handle.close()
  })

  it("logs claude turn finished with isError false on a success result message", async () => {
    const { logger, entries } = makeRecordingLogger()
    const resultMsg: SdkMessageLike = {
      type: "result",
      subtype: "success",
      is_error: false,
    }
    const fake = makeFakeSdk([resultMsg])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    await adapter.start(input, makeCtx([], []))
    await new Promise((r) => setTimeout(r, 20))
    const finishedEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude turn finished",
    )
    expect(finishedEntry).toBeDefined()
    expect(finishedEntry?.fields?.isError).toBe(false)
    expect(finishedEntry?.fields?.subtype).toBe("success")
  })

  it("logs claude turn finished with isError true on an error result message", async () => {
    const { logger, entries } = makeRecordingLogger()
    const resultMsg: SdkMessageLike = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    }
    const fake = makeFakeSdk([resultMsg])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    await adapter.start(input, makeCtx([], []))
    await new Promise((r) => setTimeout(r, 20))
    const finishedEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude turn finished",
    )
    expect(finishedEntry).toBeDefined()
    expect(finishedEntry?.fields?.isError).toBe(true)
    expect(finishedEntry?.fields?.subtype).toBe("error_during_execution")
  })

  it("logs claude sdk stream ended when the sdk generator completes normally", async () => {
    const { logger, entries } = makeRecordingLogger()
    // A scripted SDK whose generator finishes after yielding one message
    const fake = makeFakeSdk([{ type: "system", subtype: "init", model: "m" }])
    const adapter = createClaudeAdapter({
      loadSdk: async () => fake.sdk,
      logger,
    })
    const handle = await adapter.start(input, makeCtx([], []))
    // Drain messages then close so the for-await completes
    await new Promise((r) => setTimeout(r, 10))
    handle.close()
    await new Promise((r) => setTimeout(r, 10))
    const streamEndedEntry = entries.find(
      (e) => e.level === "info" && e.msg === "claude sdk stream ended",
    )
    expect(streamEndedEntry).toBeDefined()
  })

  // --- Finding 3: rapid double setMode → stale rejection ---------------------------------

  it("ignores a stale rejection after a newer restart already happened", async () => {
    // We need two rejections that we can resolve in controlled order.
    // Use a custom SDK where setPermissionMode rejects with a controllable deferred.
    const queries: QueryRecord[] = []
    const rejectDeferreds: Array<{ reject: (e: Error) => void }> = []

    const sdk: ClaudeSdk = {
      query: (args) => {
        const done = defer<void>()
        const msgQueue: SdkMessageLike[] = []
        let msgWake: (() => void) | null = null

        const record: QueryRecord = {
          options: args.options,
          pushedPrompts: [],
          closes: 0,
          setPermissionModeCalls: [],
          unblock: () => done.resolve(),
          pushMsg: (msg) => {
            msgQueue.push(msg)
            msgWake?.()
            msgWake = null
          },
        }
        queries.push(record)

        void (async () => {
          for await (const m of args.prompt) record.pushedPrompts.push(m)
        })()

        const iterator = (async function* (): AsyncGenerator<SdkMessageLike> {
          while (true) {
            while (msgQueue.length > 0) {
              const msg = msgQueue.shift()
              if (msg !== undefined) yield msg
            }
            const raceWake = new Promise<void>((r) => {
              msgWake = r
            })
            let finished = false
            done.promise.then(() => {
              finished = true
              msgWake?.()
              msgWake = null
            })
            await raceWake
            if (finished && msgQueue.length === 0) break
          }
        })()

        const q: ClaudeQuery = Object.assign(iterator, {
          interrupt: async () => {},
          close: () => {
            record.closes += 1
            done.resolve()
          },
          setPermissionMode: async (mode: string) => {
            record.setPermissionModeCalls.push(mode)
            // Each call to setPermissionMode gets its own controllable deferred rejection.
            await new Promise<void>((_resolve, reject) => {
              rejectDeferreds.push({ reject })
            })
          },
        })
        return q
      },
    }

    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    // Push session id so restarts can resume.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_rapid",
    })
    await new Promise((r) => setTimeout(r, 10))

    // Two rapid setMode calls — both hit setPermissionMode before either rejects.
    handle.setMode?.("bypass")
    handle.setMode?.("plan")
    await new Promise((r) => setTimeout(r, 10))

    // Now reject the FIRST setPermissionMode — this should trigger restart #1.
    rejectDeferreds[0]?.reject(new Error("rejected-first"))
    await new Promise((r) => setTimeout(r, 20))

    // Now reject the SECOND setPermissionMode — this is stale (a newer restart already
    // happened), so it must NOT trigger a third query.
    rejectDeferreds[1]?.reject(new Error("rejected-second"))
    await new Promise((r) => setTimeout(r, 20))

    // Exactly TWO queries: the original + one restart.
    // A third query would mean the stale rejection triggered an extra restart.
    expect(queries).toHaveLength(2)
  })

  // --- Task 6: interrupt drains the input-stream queue -----------------------------------

  it("does not deliver queued turns to the SDK after interrupt", async () => {
    // Arrange a fake SDK that records each user input it pulls from the prompt stream.
    // We reuse the existing multi-query fake so we can observe which prompts were pulled.
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    // Send three turns rapidly, then interrupt immediately.
    handle.send("turn-1")
    handle.send("turn-2")
    handle.send("turn-3")
    handle.interrupt()

    // Wait for any microtasks / async draining that might happen.
    await new Promise((r) => setTimeout(r, 20))

    // Collect all text content that the fake query observed from the prompt stream.
    const pulled = (queries[0]?.pushedPrompts ?? []) as Array<{
      type: string
      message: { role: string; content: string }
      parent_tool_use_id: null
    }>
    const pulledTexts = pulled.map((p) => p.message.content)

    // After interrupt the queue must have been drained: turn-2 and turn-3 were still
    // queued when interrupt fired and must NOT have been delivered to the SDK.
    expect(pulledTexts).not.toContain("turn-2")
    expect(pulledTexts).not.toContain("turn-3")

    handle.close()
  })

  // --- Task 2: refusal_fallback_prompt dialog via onUserDialog ----------------------------

  it("declares the refusal_fallback_prompt dialog kind", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))
    const opts = fake.capturedOptions()
    expect(opts.supportedDialogKinds).toContain("refusal_fallback_prompt")
    expect(opts.supportedDialogKinds).not.toContain("ask_user_question")
  })

  it("routes a refusal_fallback_prompt dialog through ctx.requestQuestion and returns the chosen result", async () => {
    const fake = makeFakeSdk([])
    const emitted: CanonicalEvent[] = []
    const approvals: Array<{
      runnerId: RunnerId
      resolve: (d: "allow" | "deny") => void
    }> = []
    const questions: Array<{
      runnerId: RunnerId
      requestId: string
      resolve: (a: QuestionAnswer) => void
    }> = []
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx(emitted, approvals, questions))

    const onUserDialog = fake.capturedOptions().onUserDialog
    if (onUserDialog === undefined) throw new Error("onUserDialog not set")

    const signal = new AbortController().signal
    const resultP = onUserDialog(
      {
        dialogKind: "refusal_fallback_prompt",
        payload: { originalModel: "opus", fallbackModel: "sonnet" },
      },
      { signal },
    )

    // Allow requestQuestion to be called
    await Promise.resolve()

    const questionReq = emitted.find((e) => e.type === "question-requested")
    if (questionReq?.type !== "question-requested")
      throw new Error("expected a question-requested event")

    // Resolve with the FIRST option's label, read from the prompt the glue emitted,
    // so this stays coupled to the real mapper output (a label rename must break it).
    const retryLabel = questionReq.prompt.questions[0]?.options[0]?.label
    if (retryLabel === undefined)
      throw new Error("expected a retry option label")
    questions[0]?.resolve({
      selections: [{ questionIndex: 0, labels: [retryLabel] }],
    })

    const result = await resultP
    expect(result).toEqual({ behavior: "completed", result: "retry_fallback" })
  })

  it("returns cancelled for an unrecognized dialog kind", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))

    const onUserDialog = fake.capturedOptions().onUserDialog
    if (onUserDialog === undefined) throw new Error("onUserDialog not set")

    const result = await onUserDialog(
      { dialogKind: "something_else", payload: {} },
      { signal: new AbortController().signal },
    )
    expect(result).toEqual({ behavior: "cancelled" })
  })

  it("returns cancelled when the refusal payload is malformed", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))

    const onUserDialog = fake.capturedOptions().onUserDialog
    if (onUserDialog === undefined) throw new Error("onUserDialog not set")

    const result = await onUserDialog(
      { dialogKind: "refusal_fallback_prompt", payload: { nope: 1 } },
      { signal: new AbortController().signal },
    )
    expect(result).toEqual({ behavior: "cancelled" })
  })

  it("returns cancelled when the signal is already aborted", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], [], []))

    const onUserDialog = fake.capturedOptions().onUserDialog
    if (onUserDialog === undefined) throw new Error("onUserDialog not set")

    const abort = new AbortController()
    abort.abort()

    const result = await onUserDialog(
      {
        dialogKind: "refusal_fallback_prompt",
        payload: { originalModel: "opus", fallbackModel: "sonnet" },
      },
      { signal: abort.signal },
    )
    expect(result).toEqual({ behavior: "cancelled" })
  })

  // --- Task B6: thinking-effort → SDK thinking option ------------------------------------

  it("passes the thinking option when input.thinkingEffort is set to a non-off tier", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start({ ...input, thinkingEffort: "medium" }, makeCtx([], []))
    const opts = fake.capturedOptions()
    expect(opts.thinking).toEqual({ type: "adaptive" })
    expect(opts.effort).toBe("medium")
  })

  it("omits the thinking option when input.thinkingEffort is off", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start({ ...input, thinkingEffort: "off" }, makeCtx([], []))
    const opts = fake.capturedOptions()
    expect(opts.thinking).toBeUndefined()
  })

  it("omits the thinking option when input.thinkingEffort is absent", async () => {
    const fake = makeFakeSdk([])
    const adapter = createClaudeAdapter({ loadSdk: async () => fake.sdk })
    await adapter.start(input, makeCtx([], []))
    const opts = fake.capturedOptions()
    expect(opts.thinking).toBeUndefined()
  })

  it("setThinkingEffort relaunches the query with the new thinking budget, resuming the claude session", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(input, makeCtx([], []))

    // Push an init message so the glue captures the claude session id.
    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_think",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setThinkingEffort?.("high")
    await new Promise((r) => setTimeout(r, 20))

    // Two query() calls: the original and the relaunched one.
    expect(queries).toHaveLength(2)
    // Second call carries the new thinking option and the captured session id (resume).
    expect(queries[1]?.options?.thinking).toEqual({ type: "adaptive" })
    expect(queries[1]?.options?.effort).toBe("high")
    expect(queries[1]?.options?.resume).toBe("sess_think")
  })

  it("setThinkingEffort to off omits the thinking option on the relaunched query", async () => {
    const { sdk, queries } = makeMultiQueryFakeSdk("resolve")
    const adapter = createClaudeAdapter({ loadSdk: async () => sdk })
    const handle = await adapter.start(
      { ...input, thinkingEffort: "high" },
      makeCtx([], []),
    )

    queries[0]?.pushMsg({
      type: "system",
      subtype: "init",
      model: "m",
      session_id: "sess_think_off",
    })
    await new Promise((r) => setTimeout(r, 10))

    handle.setThinkingEffort?.("off")
    await new Promise((r) => setTimeout(r, 20))

    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.thinking).toBeUndefined()
    expect(queries[1]?.options?.resume).toBe("sess_think_off")
  })
})
