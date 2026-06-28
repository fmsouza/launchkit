import type {
  CanonicalEvent,
  PermissionMode,
  StoredEvent,
  ThinkingEffort,
} from "@spectrum/agent-events"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import type { HarnessId, ModelId, RunnerId, SessionId } from "@spectrum/types"
import { type Clock, type Result, isErr, isOk, ok } from "@spectrum/utils"
import { deriveSessionName } from "./derive-session-name"
import type { AgentDriver, AgentSession, DriverError } from "./driver"
import type { RunEventSink, SessionSink } from "./ports"
import type { RunnerInbound, RunnerOutbound } from "./protocol"

export interface RunLaunchInput {
  readonly harnessId: HarnessId
  readonly modelId?: ModelId
  /** The normalized permission mode the session starts in; absent = the driver's default ("manual"). */
  readonly permissionMode?: PermissionMode
  readonly name?: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly initialPrompt?: string
  /** The harness-resolved absolute executable, forwarded to `driver.start` (see `AgentStartInput.command`). */
  readonly command?: string
  /** The harness-resolved launch args, forwarded to `driver.start` (see `AgentStartInput.args`). */
  readonly args?: readonly string[]
  /** Harness-native session id to resume; absent = fresh start. Forwarded to `driver.start`. */
  readonly resume?: string
  /** Spectrum `SessionId` for this run; forwarded to `driver.start` for callback binding. */
  readonly sessionId?: SessionId
  /** The thinking-effort tier the session starts at; absent = the harness default. */
  readonly thinkingEffort?: ThinkingEffort
}

export interface RunManagerDeps {
  readonly driver: AgentDriver
  readonly sessions: SessionSink
  readonly events: RunEventSink
  readonly clock: Clock
  /** Optional structured logger (default noop). Logs lifecycle ids/kinds only — never message content. */
  readonly logger?: Logger
  /**
   * Re-render a session's route env for an in-session model change. Injected by the composition
   * root (the manager stays free of config/proxy/harnesses deps). Returns the proxy env vars
   * (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL / …) for a real model id.
   */
  readonly resolveModelEnv?: (input: {
    readonly harnessId: HarnessId
    readonly modelId: ModelId | null
  }) => Promise<Readonly<Record<string, string>>>
  /**
   * Re-resolve a complete RunLaunchInput (env, command, args) for a resumed session from
   * its persisted row. Implemented in the composition root (keeps the manager free of
   * harness/proxy deps). Absent (unit tests) ⇒ a minimal input with cwd/env only.
   */
  readonly resolveResumeInput?: (session: {
    readonly harnessId: HarnessId
    readonly modelId?: ModelId
    readonly cwd: string
  }) => Promise<RunLaunchInput>
  send(message: RunnerOutbound): void
}

export interface RunManager {
  launch(
    input: RunLaunchInput,
  ): Result<{ readonly sessionId: SessionId }, DriverError>
  handleInbound(message: RunnerInbound): void
  /** Late-bound once the runner socket connects; replaces the `send` sink. */
  bindSend(send: (message: RunnerOutbound) => void): void
  /** Mark a session's name as user-set so a live run stops auto/harness-naming it. */
  markUserNamed(id: SessionId): void
}

export const createRunManager = (deps: RunManagerDeps): RunManager => {
  const live = new Map<SessionId, AgentSession>()
  const harnessOf = new Map<SessionId, HarnessId>()
  /** Per-session naming guard: none = not yet named, auto = derived/harness-named, user = sticky. */
  const nameSource = new Map<SessionId, "none" | "auto" | "user">()
  const logger = deps.logger ?? createNoopLogger()
  let sink: (message: RunnerOutbound) => void = deps.send
  const send = (message: RunnerOutbound): void => sink(message)

  const launch = (
    input: RunLaunchInput,
  ): Result<{ readonly sessionId: SessionId }, DriverError> => {
    const session = deps.sessions.create({
      harnessId: input.harnessId,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      cwd: input.cwd,
    })
    if (isErr(session)) {
      // Observe the failure WITHOUT changing control flow. The error detail is a session-store
      // failure kind/detail (no secrets); the harnessId is a safe lifecycle id.
      logger.error("session start failed", {
        kind: "start-failed",
        harnessId: input.harnessId,
      })
      return {
        ok: false,
        error: {
          kind: "start-failed",
          detail: session.error.detail ?? session.error.kind,
        },
      }
    }
    const id = session.value.id

    const started = deps.driver.start({
      harnessId: input.harnessId,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.permissionMode !== undefined
        ? { permissionMode: input.permissionMode }
        : {}),
      cwd: input.cwd,
      env: input.env,
      ...(input.initialPrompt !== undefined
        ? { initialPrompt: input.initialPrompt }
        : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.resume !== undefined ? { resume: input.resume } : {}),
      ...(input.thinkingEffort !== undefined
        ? { thinkingEffort: input.thinkingEffort }
        : {}),
      // The manager mints the id via sessions.create above; the driver needs it for callback
      // binding (FakeDriver's resumeToken persistence gate checks input.sessionId !== undefined).
      sessionId: id,
    })
    if (isErr(started)) {
      // Driver start boundary failure. `kind` is a DriverError kind (e.g. "start-failed"); the
      // harnessId is a safe lifecycle id. No prompt/env/secret is logged.
      logger.error("driver start failed", {
        kind: started.error.kind,
        harnessId: input.harnessId,
      })
      deps.sessions.close(id, 1)
      return started
    }
    const agent = started.value
    live.set(id, agent)
    harnessOf.set(id, input.harnessId)
    nameSource.set(id, input.name !== undefined ? "user" : "none")
    logger.info("session launched", {
      sessionId: id,
      harnessId: input.harnessId,
    })

    agent.onEvent((event: CanonicalEvent) => wireOnEvent(id, agent, event))
    return ok({ sessionId: id })
  }

  // Shared persist-then-forward fan-out for both `launch` and `doResume`. Mirrors
  // TerminalManager's onData → scrollback.append + send. Closes the session and drops
  // the live handle when the root runner finishes, so a later run-send triggers resume.
  const wireOnEvent = (
    id: SessionId,
    agent: AgentSession,
    event: CanonicalEvent,
  ): void => {
    const appended = deps.events.append(id, event)
    if (isOk(appended)) {
      const stored: StoredEvent = {
        seq: appended.value.seq,
        sessionId: id,
        ts: deps.clock.now().toISOString(),
        event,
      }
      send({ type: "runner-event", id, event: stored })
    }
    // Close is intentionally independent of persist success: the session must be
    // marked finished in the DB even if the final event failed to append to the store.
    // Dropping the live handle here is what makes a later run-send trigger a resume.
    if (
      event.type === "runner-finished" &&
      event.runnerId === agent.rootRunnerId
    ) {
      deps.sessions.close(id, 0)
      agent.close()
      live.delete(id)
      logger.info("session closed", { sessionId: id })
    }

    // Session naming: derive from the first user turn (fallback) or refine from a
    // harness-emitted root title. A user-set name (CLI --name or a manual rename via
    // markUserNamed) is sticky and never overwritten. Failures are observed + swallowed.
    if (event.runnerId === agent.rootRunnerId) {
      const source = nameSource.get(id) ?? "none"
      if (
        event.type === "text-delta" &&
        event.role === "user" &&
        source === "none"
      ) {
        const derived = deriveSessionName(event.text)
        if (derived !== "") {
          const written = deps.sessions.updateName(id, derived)
          if (isOk(written)) {
            nameSource.set(id, "auto")
            send({ type: "session-renamed", id, name: derived })
          } else {
            logger.error("session name update failed", {
              sessionId: id,
              kind: written.error.kind,
            })
          }
        }
      } else if (
        event.type === "runner-started" &&
        event.title !== undefined &&
        source !== "user"
      ) {
        const written = deps.sessions.updateName(id, event.title)
        if (isOk(written)) {
          nameSource.set(id, "auto")
          send({ type: "session-renamed", id, name: event.title })
        } else {
          logger.error("session name update failed", {
            sessionId: id,
            kind: written.error.kind,
          })
        }
      }
    }
  }

  // Per-session queue of pending sends while a resume is in flight. The first
  // run-send for an ended session seeds the queue and triggers `doResume`; any
  // concurrent sends for the same session pile onto the queue and are flushed
  // when the resume completes. This serializes "two rapid sends" into ONE resume.
  const resuming = new Map<
    SessionId,
    Array<{ text: string; clientSendId?: string }>
  >()

  const resumeAndSend = (
    id: SessionId,
    text: string,
    clientSendId?: string,
  ): void => {
    const turn = clientSendId !== undefined ? { text, clientSendId } : { text }
    const queued = resuming.get(id)
    if (queued !== undefined) {
      queued.push(turn)
      return
    }
    resuming.set(id, [turn])
    void doResume(id)
  }

  const doResume = async (id: SessionId): Promise<void> => {
    const got = deps.sessions.get(id)
    if (isErr(got)) {
      resuming.delete(id)
      return
    }
    const row = got.value
    if (row === undefined) {
      resuming.delete(id)
      return
    }
    const reopened = deps.sessions.reopen(id)
    if (isErr(reopened)) {
      resuming.delete(id)
      return
    }
    const base = await (deps.resolveResumeInput !== undefined
      ? deps.resolveResumeInput({
          harnessId: row.harnessId,
          ...(row.modelId !== undefined ? { modelId: row.modelId } : {}),
          cwd: row.cwd ?? "",
        })
      : Promise.resolve({
          harnessId: row.harnessId,
          cwd: row.cwd ?? "",
          env: {},
        } as RunLaunchInput))
    const started = deps.driver.start({
      harnessId: base.harnessId,
      ...(base.modelId !== undefined ? { modelId: base.modelId } : {}),
      ...(base.permissionMode !== undefined
        ? { permissionMode: base.permissionMode }
        : {}),
      cwd: base.cwd,
      env: base.env,
      ...(base.command !== undefined ? { command: base.command } : {}),
      ...(base.args !== undefined ? { args: base.args } : {}),
      ...(row.resumeId !== undefined ? { resume: row.resumeId } : {}),
      ...(base.thinkingEffort !== undefined
        ? { thinkingEffort: base.thinkingEffort }
        : {}),
      sessionId: id,
    })
    if (isErr(started)) {
      logger.error("resume start failed", { kind: started.error.kind })
      // Surface the failure to the webview as a synthetic runner-finished:errored
      // canonical event. The wireOnEvent persist+forward path handles it as a
      // normal frame; the reducer treats it as a terminal state so the UI
      // shows the failure instead of hanging on "Starting…". The id is the
      // session id (Spectrum has no RunnerId until the driver actually starts,
      // and `runner-finished.runnerId` is informational; the runViewStore
      // filters by the session id, not the runner id).
      const stored: StoredEvent = {
        seq: 0,
        sessionId: id,
        ts: deps.clock.now().toISOString(),
        event: {
          type: "runner-finished",
          runnerId: id as unknown as RunnerId,
          status: "errored",
          error: started.error.detail ?? started.error.kind,
        },
      }
      send({ type: "runner-event", id, event: stored })
      deps.sessions.close(id, 1)
      resuming.delete(id)
      return
    }
    const agent = started.value
    live.set(id, agent)
    harnessOf.set(id, base.harnessId)
    // Match launch()'s pattern: only lock the name as user-set if the row already
    // has a name. Otherwise let the new turn's auto-derived name overwrite.
    nameSource.set(id, row.name !== undefined ? "user" : "none")
    logger.info("session resumed", { sessionId: id })

    // Replay the stored backlog so the conversation reappears, then flush queued sends.
    const read = deps.events.read(id)
    if (isOk(read)) {
      for (const stored of read.value) {
        send({ type: "runner-event", id, event: stored })
      }
    }
    // Fresh-restart toast signal when the harness can't true-resume.
    if (row.resumeId === undefined) {
      send({ type: "session-resume-token", id, resumeToken: "" })
    }

    agent.onEvent((event: CanonicalEvent) => wireOnEvent(id, agent, event))

    const queued = resuming.get(id) ?? []
    resuming.delete(id)
    for (const q of queued) {
      agent.send(q)
    }
  }

  const handleInbound = (message: RunnerInbound): void => {
    if (message.type === "run-attach") {
      // `events.read` is called unconditionally. For an unknown/never-launched sessionId
      // it returns an empty backlog (or a handled error), so nothing is replayed — safe no-op.
      const read = deps.events.read(message.id)
      if (isOk(read)) {
        for (const stored of read.value) {
          send({ type: "runner-event", id: message.id, event: stored })
        }
      }
      return
    }
    const agent = live.get(message.id)
    if (agent === undefined) {
      // No live session — for run-send, lazily auto-resume; for run-interrupt,
      // drop any queued resume sends so a pending resume does not fire afterward.
      if (message.type === "run-send") {
        resumeAndSend(message.id, message.text, message.clientSendId)
      } else if (message.type === "run-interrupt") {
        resuming.delete(message.id)
      }
      return
    }
    // The runner socket protocol has no error-reply frame, so Results from these commands
    // are intentionally dropped here. Driver failures are surfaced as canonical events
    // through onEvent (e.g. a runner-finished with status "errored") which flow through
    // the normal persist+forward path.
    switch (message.type) {
      case "run-send":
        agent.send(
          message.clientSendId !== undefined
            ? { text: message.text, clientSendId: message.clientSendId }
            : { text: message.text },
        )
        return
      case "run-approve":
        agent.respondApproval(message.requestId, message.decision)
        return
      case "run-answer":
        agent.respondQuestion(message.requestId, message.answer)
        return
      case "run-interrupt":
        resuming.delete(message.id)
        agent.interrupt()
        return
      case "run-set-mode":
        agent.setMode?.(message.mode)
        return
      case "run-set-thinking-effort":
        agent.setThinkingEffort?.(message.effort)
        return
      case "run-set-model": {
        const harnessId = harnessOf.get(message.id)
        if (deps.resolveModelEnv === undefined || harnessId === undefined) {
          agent.setModel?.(message.modelId)
          return
        }
        // Async resolve (reads the per-run proxy key); the socket protocol has no reply frame,
        // so failures surface as canonical events from the relaunched driver, not here.
        void deps
          .resolveModelEnv({ harnessId, modelId: message.modelId })
          .then((env) => agent.setModel?.(message.modelId, env))
          .catch((err: unknown) => {
            logger.error("resolveModelEnv failed", {
              sessionId: message.id,
              harnessId,
              modelId: message.modelId,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        return
      }
      default:
        // Compile-time exhaustiveness: a new RunnerInbound variant fails the build here.
        message satisfies never
        return
    }
  }

  const bindSend = (next: (message: RunnerOutbound) => void): void => {
    sink = next
  }

  const markUserNamed = (id: SessionId): void => {
    // Only flip for sessions the manager knows; a rename of an unknown/closed
    // session is a harmless no-op (the persisted name is still the source of truth).
    if (live.has(id) || nameSource.has(id)) nameSource.set(id, "user")
  }

  return { launch, handleInbound, bindSend, markUserNamed }
}
