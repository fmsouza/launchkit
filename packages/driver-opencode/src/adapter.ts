import type { AgentStartInput } from "@spectrum/agent-driver"
import type { ApprovalDecision, PermissionMode } from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import { mapOpencodeEvent, newOpencodeMapState } from "./map-opencode-event"
import {
  type OpencodeClient,
  type OpencodeConnect,
  type OpencodeConnectConfig,
  type OpencodeServer,
  buildOpencodeProxyConfig,
} from "./transport"

/**
 * Permission modes supported by the OpenCode adapter.
 * - "manual": user is prompted for every permission (default).
 * - "plan": prompts are routed to OpenCode's plan agent (body gains `agent: "plan"`).
 * - "bypass": permission.updated events are auto-approved with `response: "always"`,
 *   skipping the requestApproval bridge entirely.
 * NOTE: "auto-edits" is NOT included — the permission.updated payload has no verified
 * edit-vs-command discriminator in the current SDK.
 */
export const OPENCODE_SUPPORTED_MODES: readonly PermissionMode[] = [
  "manual",
  "plan",
  "bypass",
]

export interface OpencodeAdapterDeps {
  /** Start/connect `opencode serve` + client (injected; real impl wraps @opencode-ai/sdk). */
  readonly connect: OpencodeConnect
  /**
   * #6573 guard: if no `session.idle` arrives within this many ms after the last activity, finish the
   * root runner as `errored` and reap the server (the subagent-over-REST hang). 0 disables (tests).
   * Defaults to 180_000 in createOpencodeDriver.
   */
  readonly watchdogMs: number
  /** Injected timers so the watchdog is unit-testable. Defaults to global setTimeout/clearTimeout. */
  readonly setTimer?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

const readConfig = (
  input: AgentStartInput,
  env: Readonly<Record<string, string>>,
): OpencodeConnectConfig => {
  const baseUrl = env.OPENCODE_BASE_URL ?? input.env.OPENCODE_BASE_URL
  const config = buildOpencodeProxyConfig(env)
  return {
    cwd: input.cwd,
    env,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(config !== undefined ? { config } : {}),
  }
}

const replyFor = (decision: ApprovalDecision): "once" | "always" | "reject" =>
  decision === "deny"
    ? "reject"
    : decision === "allow-always"
      ? "always"
      : "once"

/**
 * The OpenCode adapter. `start` connects to `opencode serve`, creates the root session, emits the root
 * runner-started, subscribes the GLOBAL SSE bus, and drains it into ctx.emit(mapOpencodeEvent(...)) — the
 * mapper filters by sessionID (the bus is server-wide). `permission.updated` bridges via ctx.requestApproval
 * then replies (once/always/reject). A watchdog finishes the run if it hangs (#6573). The handle controls
 * prompt/abort/close/setMode. The drain runs detached; stream errors surface as a runner-finished(errored)
 * (mapper session.error) or the runtime's rejected-start path.
 *
 * `setModel` is a heavyweight fresh-restart: the proxy model is baked into the spawned server's config, so
 * changing it tears down the current server + SSE subscription + watchdog and re-runs
 * connect → create session → subscribe → drain with a swapped `OPENAI_MODEL`. The root `runnerId` stays
 * the same (same conversation view); OpenCode's own context resets (fresh session). A generation counter
 * guards the old drain so a late event from the old subscription cannot re-emit under the new model.
 */
export const createOpencodeAdapter = (
  deps: OpencodeAdapterDeps,
): DriverAdapter => ({
  supportedModes: OPENCODE_SUPPORTED_MODES,
  start: async (input, ctx: AdapterCtx): Promise<AdapterHandle> => {
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

    let mode: PermissionMode = input.permissionMode ?? "manual"

    // permissionID -> the OpenCode sessionID that raised it, so a reply hits the right REST path.
    // Scoped to a single (re)connect: a fresh setModel reconnect starts a fresh map because the
    // permission map's only purpose is to relay replies back to the live session/perms REST call.
    const permissionSessions = new Map<string, string>()
    let closed = false
    // Bumped on every (re)connect and on close(); the drain captures `myGen` and bails on a change,
    // and the watchdog callback checks it before reaping a server.
    let gen = 0

    // The live server + session; mutated by connectAndRun + close. Read by handle.send / handle.interrupt.
    let currentServer: OpencodeServer | undefined
    let currentClient: OpencodeClient | undefined
    let currentSessionId: string | undefined

    // #6573 watchdog: arm on activity; fire -> errored + reap. Lives on the live server only —
    // a stale timer would reap the WRONG server after a setModel restart. The setTimer's tick
    // path captures `myGen` so a stale timer (the old gen's) cannot fire against the new server.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const disarm = (): void => {
      if (watchdog !== undefined) {
        clearTimer(watchdog)
        watchdog = undefined
      }
    }
    const arm = (): void => {
      if (deps.watchdogMs <= 0 || closed) return
      disarm()
      const myGen = gen
      watchdog = setTimer(() => {
        if (closed) return
        if (myGen !== gen) return // stale timer from a previous setModel restart
        ctx.emit({
          type: "runner-finished",
          runnerId: ctx.rootRunnerId,
          status: "errored",
          error: `opencode session stalled (no session.idle within ${deps.watchdogMs}ms; possible subagent-over-REST hang #6573)`,
        })
        currentServer?.close()
      }, deps.watchdogMs)
    }

    // Reconnect helper: (re)start a server, recreate the root session, re-subscribe, restart the drain,
    // and (optionally) send the initial prompt. `model` is carried on the runner-started re-emit so the
    // reducer stamps the new model. `isInitial` controls whether to send the initialPrompt; it is
    // consumed exactly once on the first start.
    const connectAndRun = async (
      env: Readonly<Record<string, string>>,
      options: { readonly model?: string; readonly isInitial: boolean },
    ): Promise<void> => {
      const myGen = ++gen
      const { client, server } = await deps.connect(readConfig(input, env))
      const created = await client.session.create({ body: {} })
      const sessionId = created.id
      const state = newOpencodeMapState({
        rootRunnerId: ctx.rootRunnerId,
        rootSessionId: sessionId,
        newRunnerId: ctx.newRunnerId,
      })

      // Root announcement — the runtime already emitted one up front; this re-emit carries the model
      // on a setModel restart. The reducer treats re-emit as idempotent (preserves existing items).
      ctx.emit({
        type: "runner-started",
        runnerId: ctx.rootRunnerId,
        ...(options.model !== undefined ? { model: options.model } : {}),
      })

      const subscription = await client.event.subscribe()

      // Detached drain of the (directory-scoped) bus, filtered by the mapper. The gen guard
      // guarantees a late event from a stale subscription cannot leak into the new model.
      void (async () => {
        for await (const event of subscription.stream) {
          if (closed) return
          if (gen !== myGen) return
          arm()
          if (event.type === "permission.updated") {
            // In scope only for a known session. The mapper returns [] for permission
            // events — the runtime approval bridge below owns approval-requested.
            const sess = event.properties.sessionID
            const runner = state.sessions.get(sess)
            if (runner !== undefined) {
              permissionSessions.set(event.properties.id, sess)
              if (mode === "bypass") {
                // Bypass: auto-approve with "always" — skip the UI approval card entirely
                // (don't emit approval-requested, don't call requestApproval).
                await client.session.permissions({
                  path: { id: sess, permissionID: event.properties.id },
                  body: { response: "always" },
                })
              } else {
                // Manual: bridge to requestApproval (the runtime emits approval-requested).
                const decision = await ctx.requestApproval(runner, {
                  kind: "command",
                  detail:
                    typeof event.properties.pattern === "string"
                      ? event.properties.pattern
                      : event.properties.title,
                })
                await client.session.permissions({
                  path: { id: sess, permissionID: event.properties.id },
                  body: { response: replyFor(decision) },
                })
              }
            }
            // Skip mapper for unknown sessions (it returns [] anyway).
          } else {
            for (const canonical of mapOpencodeEvent(event, state))
              ctx.emit(canonical)
          }
          if (
            event.type === "session.idle" &&
            event.properties.sessionID === sessionId
          )
            disarm()
        }
      })()

      // Build a prompt body with optional agent field for plan mode.
      const promptBody = (
        text: string,
      ): {
        parts: ReadonlyArray<{ type: "text"; text: string }>
        agent?: string
      } => ({
        parts: [{ type: "text", text }],
        ...(mode === "plan" ? { agent: "plan" } : {}),
      })

      // Initial prompt — sent only on the very first start. A setModel reconnect starts a fresh
      // OpenCode session that has no prior context; re-sending the original initialPrompt would be
      // surprising and is intentionally omitted.
      if (
        options.isInitial &&
        input.initialPrompt !== undefined &&
        input.initialPrompt !== ""
      ) {
        arm()
        await client.session.prompt({
          path: { id: sessionId },
          body: promptBody(input.initialPrompt),
        })
      }

      // Publish the live handles AFTER setup so handle.send / handle.interrupt read the new session.
      currentServer = server
      currentClient = client
      currentSessionId = sessionId
    }

    // First connect.
    await connectAndRun(input.env, { isInitial: true })

    return {
      send: (text) => {
        // Build the prompt body against the current mode (so setMode applies even mid-async-restart).
        const promptBody = (
          text: string,
        ): {
          parts: ReadonlyArray<{ type: "text"; text: string }>
          agent?: string
        } => ({
          parts: [{ type: "text", text }],
          ...(mode === "plan" ? { agent: "plan" } : {}),
        })
        arm()
        const sid = currentSessionId
        const cli = currentClient
        if (sid === undefined || cli === undefined) return
        void cli.session.prompt({
          path: { id: sid },
          body: promptBody(text),
        })
      },
      interrupt: () => {
        const sid = currentSessionId
        const cli = currentClient
        if (sid === undefined || cli === undefined) return
        void cli.session.abort({ path: { id: sid } })
      },
      close: () => {
        if (closed) return
        closed = true
        disarm()
        // Bumping the gen causes any in-flight drain to exit; closing the server tears down SSE.
        gen++
        currentServer?.close()
        currentServer = undefined
        currentClient = undefined
        currentSessionId = undefined
      },
      setMode: (m) => {
        mode = m
      },
      setModel: (modelId) => {
        // Fresh server restart: tear down the live server, then reconnect with OPENAI_MODEL swapped.
        // Fire-and-forget — the next send/interrupt will use the new session id once connectAndRun
        // has installed it. Old drain / old watchdog are guarded by the gen bump.
        const serverToReap = currentServer
        gen++
        currentServer = undefined
        currentClient = undefined
        currentSessionId = undefined
        disarm()
        serverToReap?.close()
        void connectAndRun(
          { ...input.env, OPENAI_MODEL: String(modelId) },
          { model: String(modelId), isInitial: false },
        )
      },
      // OpenCode routes through the Spectrum proxy (OPENAI_MODEL / provider config) and exposes no
      // per-turn reasoning-effort knob today; accept the tier so the seam is uniform and the UI
      // selector is harmless. No-op by design.
      setThinkingEffort: () => {},
    }
  },
})
