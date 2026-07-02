import type { AgentStartInput } from "@spectrum/agent-driver"
import type {
  ApprovalDecision,
  ApprovalTarget,
  AttachmentRefWithBytes,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type {
  AdapterCtx,
  AdapterHandle,
  DriverAdapter,
} from "@spectrum/driver-runtime"
import type { Logger } from "@spectrum/logger"
import {
  mapAnswerToUpdatedInput,
  mapAskUserQuestionPayload,
} from "./ask-user-question"
import { initialClaudeMapState, mapClaudeMessage } from "./map-claude-message"
import {
  CLAUDE_SUPPORTED_MODES,
  toClaudePermissionMode,
} from "./permission-mode"
import {
  mapAnswerToRefusalChoice,
  mapRefusalFallbackPayload,
} from "./refusal-fallback"
import type { SdkMessageLike, SdkResultMessage } from "./sdk-types"
import { toClaudeThinking } from "./thinking-effort"

/** Default timer implementation backed by global setTimeout/clearTimeout. */
const defaultSetTimer = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

const ABORTED = Symbol("aborted")
const raceAbort = <T>(
  p: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> => {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener("abort", onAbort, { once: true })
    void p.then((v) => {
      signal.removeEventListener("abort", onAbort)
      resolve(v)
    })
  })
}

/** A user message in the SDK's streaming-input format. */
export interface SdkUserInput {
  readonly type: "user"
  readonly message: { readonly role: "user"; readonly content: string }
  readonly parent_tool_use_id: null
}

/** A minimal `ContentBlockParam` shape (the SDK's full type is vendored externally;
 * we construct only the blocks we emit). Keep this local and structural. */
type ImageBlock = {
  type: "image"
  source: { type: "base64"; media_type: string; data: string }
}
type DocumentBlock = {
  type: "document"
  source: { type: "base64"; media_type: string; data: string }
}
type TextBlock = { type: "text"; text: string }

const parseDataUrl = (
  dataUrl: string,
): { mediaType: string; base64: string } => {
  // "data:<mediaType>;base64,<data>"
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (m === null) throw new Error("malformed data url")
  return { mediaType: m[1] ?? "", base64: m[2] ?? "" }
}

/** Compile-time exhaustiveness: adding a new AttachmentKind must force a mapping decision here. */
const unreachableKind = (kind: never): never => {
  throw new Error(`unhandled attachment kind: ${String(kind)}`)
}

const toClaudeBlock = (
  ref: AttachmentRefWithBytes,
): TextBlock | ImageBlock | DocumentBlock => {
  const { mediaType, base64 } = parseDataUrl(ref.dataUrl)
  if (ref.kind === "pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: mediaType, data: base64 },
    }
  }
  if (ref.kind === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    }
  }
  if (ref.kind === "text") {
    // Text files travel as labeled plain text — the only representation that
    // survives EVERY route (Anthropic-native AND proxied non-Anthropic models).
    const content = Buffer.from(base64, "base64").toString("utf-8")
    return {
      type: "text",
      text: `<attached-file name=${JSON.stringify(ref.displayName)} mime=${JSON.stringify(ref.mime)}>\n${content}\n</attached-file>`,
    }
  }
  if (ref.kind === "binary") {
    // Claude has no native block for arbitrary bytes — send the media-upload
    // spec's text-note fallback instead of an invalid image block.
    return {
      type: "text",
      text: `[Attached file "${ref.displayName}" (${ref.mime}, ${ref.bytes} bytes) — binary content cannot be shown inline]`,
    }
  }
  return unreachableKind(ref.kind)
}

/** A tool-permission result in the SDK's `PermissionResult` shape. */
export type SdkPermissionResult =
  | {
      readonly behavior: "allow"
      // The SDK REQUIRES this (it validates the result with zod): the tool input to run with, possibly
      // modified. We pass the original input unchanged.
      readonly updatedInput: Record<string, unknown>
    }
  | {
      readonly behavior: "deny"
      readonly message: string
      readonly interrupt?: boolean
    }

/** The subset of the SDK's `Options` the glue sets. */
export interface SdkOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly model?: string
  readonly abortController?: AbortController
  readonly permissionMode?: string
  readonly pathToClaudeCodeExecutable?: string
  readonly resume?: string
  readonly thinking?: {
    readonly type: "adaptive"
  }
  readonly effort?: "low" | "medium" | "high" | "max"
  readonly canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<SdkPermissionResult>
  readonly supportedDialogKinds?: readonly string[]
  readonly onUserDialog?: (
    request: {
      readonly dialogKind: string
      readonly payload: Record<string, unknown>
      readonly toolUseID?: string
    },
    options: { readonly signal: AbortSignal },
  ) => Promise<
    | { readonly behavior: "completed"; readonly result: unknown }
    | { readonly behavior: "cancelled" }
  >
  readonly stderr?: (data: string) => void
}

/** The subset of the SDK's `Query` the glue uses. */
export interface ClaudeQuery extends AsyncIterable<SdkMessageLike> {
  interrupt(): Promise<void>
  close(): void
  setPermissionMode?(mode: string): Promise<void>
}

/** The subset of `@anthropic-ai/claude-agent-sdk` the glue needs (injected for testing). */
export interface ClaudeSdk {
  query(args: {
    prompt: AsyncIterable<SdkUserInput>
    options?: SdkOptions
  }): ClaudeQuery
}

/** Map a canonical approval decision → the SDK's PermissionResult. */
const toPermissionResult = (
  decision: ApprovalDecision,
  input: Record<string, unknown>,
): SdkPermissionResult =>
  decision === "deny"
    ? { behavior: "deny", message: "Denied by user" }
    : { behavior: "allow", updatedInput: input } // allow + allow-always both proceed

/** Infer an ApprovalTarget from the tool name + input (command/file/tool). */
const targetFor = (
  toolName: string,
  input: Record<string, unknown>,
): ApprovalTarget => {
  if (toolName === "Bash" && typeof input.command === "string")
    return { kind: "command", detail: input.command }
  if (
    (toolName === "Edit" || toolName === "Write") &&
    typeof input.file_path === "string"
  )
    return { kind: "file", detail: input.file_path }
  return { kind: "tool", detail: toolName }
}

/** A queue-backed async generator the caller pushes user turns into; `end()` closes the stream. */
const makeInputStream = (): {
  stream: AsyncGenerator<SdkUserInput>
  push: (turn: {
    readonly text: string
    readonly attachments?: readonly AttachmentRefWithBytes[]
  }) => void
  drain: () => void
  end: () => void
} => {
  const queue: SdkUserInput[] = []
  let wake: (() => void) | null = null
  let ended = false
  const next = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve
    })
  const stream = (async function* (): AsyncGenerator<SdkUserInput> {
    while (true) {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item !== undefined) yield item
      }
      if (ended) return
      await next()
    }
  })()
  return {
    stream,
    push: (turn) => {
      const blocks: Array<TextBlock | ImageBlock | DocumentBlock> = [
        { type: "text", text: turn.text },
      ]
      for (const a of turn.attachments ?? []) blocks.push(toClaudeBlock(a))
      queue.push({
        type: "user",
        message: {
          role: "user",
          // SDK MessageParam.content accepts string | ContentBlockParam[]; the local
          // SdkUserInput type hardcodes `content: string` (stale), so cast the blocks
          // through `unknown` to bridge the local type without loosening it broadly.
          content: blocks as unknown as string,
        },
        parent_tool_use_id: null,
      })
      wake?.()
      wake = null
    },
    drain: () => {
      queue.length = 0
    },
    end: () => {
      ended = true
      wake?.()
      wake = null
    },
  }
}

/**
 * Build the Claude `DriverAdapter`.
 *
 * - `loadSdk` lazily loads `@anthropic-ai/claude-agent-sdk` (injected so tests pass a fake `query`).
 * - The Claude executable is taken from `input.command` (the harness-resolved absolute `claude`),
 *   falling back to `deps.pathToClaudeExecutable`. This is REQUIRED in the bundled app: the SDK's own
 *   default resolution is bundle-relative and finds no `cli.js` (the packaged binary ships no
 *   node_modules), so without an explicit path `query()` throws "Claude Code executable not found".
 * - `baseEnv` (default `process.env`) is merged UNDER `input.env` — the spawned `claude` inherits the
 *   parent `PATH`/`HOME` (so it can resolve tools and read its auth/config dir) while the per-run proxy
 *   vars win (`{ ...process.env, ...input.env }`).
 */
export const createClaudeAdapter = (deps: {
  loadSdk: () => Promise<ClaudeSdk>
  pathToClaudeExecutable?: string
  baseEnv?: () => Record<string, string | undefined>
  logger?: Logger
  setTimer?: (fn: () => void, ms: number) => () => void
  responseTimeoutMs?: number
}): DriverAdapter => ({
  supportedModes: CLAUDE_SUPPORTED_MODES,
  // Claude accepts all three kinds as native content blocks: image (base64) for
  // images, document (base64) for PDFs, and any binary via the document block.
  supportedAttachments: { image: true, pdf: true, binary: true },
  start: async (
    input: AgentStartInput,
    ctx: AdapterCtx,
  ): Promise<AdapterHandle> => {
    const log = deps.logger
    const setTimer = deps.setTimer ?? defaultSetTimer
    const responseTimeoutMs = deps.responseTimeoutMs ?? 30000

    // Mutable current config: `currentMode` is the SDK permission string; `currentModel` is
    // the route id string (or undefined for the default/direct route). launch() / restart()
    // use whatever is current — setMode and setModel mutate these before relaunching.
    let currentMode = toClaudePermissionMode(input.permissionMode ?? "manual")
    let currentModel =
      input.modelId !== undefined ? String(input.modelId) : undefined
    // Mutable env: setModel may swap the route (direct↔proxied) by supplying a freshly
    // rendered proxy env. launch()/restart() always read the CURRENT env.
    let currentEnv: Readonly<Record<string, string>> = input.env
    // Mutable thinking effort: setThinkingEffort mutates and relaunches (options are fixed per query).
    let currentEffort: ThinkingEffort | undefined = input.thinkingEffort

    log?.info("claude adapter starting", {
      cwd: input.cwd,
      hasModel: currentModel !== undefined,
      mode: currentMode,
    })

    const sdk = await deps.loadSdk()

    const executable = input.command ?? deps.pathToClaudeExecutable
    log?.info("claude sdk loaded", { hasExecutable: executable !== undefined })

    const state = initialClaudeMapState(ctx.rootRunnerId)
    state.newRunnerId = ctx.newRunnerId

    /** Mutable refs shared across launch closures. */
    let claudeSessionId: string | undefined
    let closed = false
    /**
     * When setMode is called before system:init delivers a session id we cannot resume
     * yet, so we store the requested mode here and apply it once the id is known.
     */
    let pendingRestartMode: string | undefined

    /** The active query quadruple (replaced on restart). */
    let current: {
      query: ClaudeQuery
      inputStream: ReturnType<typeof makeInputStream>
      abort: AbortController
      /** Mark this launch stale so its pump's catch does not emit runner-finished errored. */
      markStale: () => void
    }

    // Per-turn watchdog state: armed on each send, disarmed when any message arrives for that turn.
    // Between turns (idle) no timer is armed.
    let awaitingResponse = false
    let cancelWatchdog: (() => void) | undefined

    const disarmWatchdog = (): void => {
      if (cancelWatchdog !== undefined) {
        cancelWatchdog()
        cancelWatchdog = undefined
      }
    }

    /**
     * Build a fresh inputStream + AbortController + sdk.query and start its pump loop.
     * Reads the current `currentMode` / `currentModel` state for options; `resume` is
     * the claude session id to resume (absent on the initial launch).
     */
    const launch = (resume?: string): typeof current => {
      const inputStream = makeInputStream()
      const abort = new AbortController()
      // Per-launch stale flag: set by restart() BEFORE tearing down this query so the
      // old pump's catch fires AFTER stale is true and swallows the teardown error.
      let stale = false
      const markStale = (): void => {
        stale = true
      }

      // Per-launch first-message tracking for the "log once" behaviour.
      let firstMsgLogged = false

      // Resolve the thinking + effort options once, gated by the active model's capability.
      // null omits both entirely (off tier, or a model with no extended thinking).
      const thinkingOpts =
        currentEffort !== undefined
          ? toClaudeThinking(currentEffort, currentModel)
          : null

      const query = sdk.query({
        prompt: inputStream.stream,
        options: {
          cwd: input.cwd,
          env: { ...(deps.baseEnv?.() ?? {}), ...currentEnv },
          ...(currentModel !== undefined ? { model: currentModel } : {}),
          ...(thinkingOpts !== null
            ? { thinking: thinkingOpts.thinking, effort: thinkingOpts.effort }
            : {}),
          abortController: abort,
          permissionMode: currentMode,
          ...(executable !== undefined
            ? { pathToClaudeCodeExecutable: executable }
            : {}),
          ...(resume !== undefined ? { resume } : {}),
          canUseTool: async (toolName, toolInput, { signal }) => {
            if (toolName === "AskUserQuestion") {
              const prompt = mapAskUserQuestionPayload(
                toolInput as Record<string, unknown>,
              )
              if (prompt === undefined) {
                log?.warn("claude AskUserQuestion input unrecognized")
                return {
                  behavior: "deny",
                  message: "Malformed AskUserQuestion input",
                }
              }
              const answer = await raceAbort(
                ctx.requestQuestion(ctx.rootRunnerId, prompt),
                signal,
              )
              if (answer === ABORTED)
                return { behavior: "deny", message: "Question cancelled" }
              return {
                behavior: "allow",
                updatedInput: mapAnswerToUpdatedInput(
                  prompt,
                  toolInput as Record<string, unknown>,
                  answer,
                ),
              }
            }
            const decision = await ctx.requestApproval(
              ctx.rootRunnerId,
              targetFor(toolName, toolInput),
            )
            return toPermissionResult(
              decision,
              toolInput as Record<string, unknown>,
            )
          },
          supportedDialogKinds: ["refusal_fallback_prompt"],
          onUserDialog: async (request, { signal }) => {
            if (request.dialogKind !== "refusal_fallback_prompt")
              return { behavior: "cancelled" }
            const prompt = mapRefusalFallbackPayload(request.payload)
            if (prompt === undefined) {
              log?.warn("claude refusal dialog payload unrecognized", {
                dialogKind: request.dialogKind,
              })
              return { behavior: "cancelled" }
            }
            const answer = await raceAbort(
              ctx.requestQuestion(ctx.rootRunnerId, prompt),
              signal,
            )
            if (answer === ABORTED) return { behavior: "cancelled" }
            return {
              behavior: "completed",
              result: mapAnswerToRefusalChoice(answer),
            }
          },
          stderr: (data) =>
            log?.warn("claude stderr", { chunk: data.slice(0, 1000) }),
        },
      })

      // Pump the SDK message stream → canonical events.
      void (async () => {
        try {
          for await (const msg of query) {
            // Log the first message seen per launch (not every message — noise).
            if (!firstMsgLogged) {
              firstMsgLogged = true
              log?.info("claude first sdk message", { type: msg.type })
            }
            // Disarm the per-turn no-response watchdog on any message arrival.
            if (awaitingResponse) {
              awaitingResponse = false
              disarmWatchdog()
            }
            // Capture the claude session id from the init message so we can resume later.
            if (
              msg.type === "system" &&
              "subtype" in msg &&
              msg.subtype === "init" &&
              "session_id" in msg &&
              typeof msg.session_id === "string"
            ) {
              claudeSessionId = msg.session_id
              ctx.reportResumeToken?.(msg.session_id)
              // Apply any mode switch that was requested before the session id was known.
              if (pendingRestartMode !== undefined) {
                const mode = pendingRestartMode
                pendingRestartMode = undefined
                currentMode = mode
                restart()
              }
            }
            // Log turn completion when a result message arrives.
            if (msg.type === "result") {
              const resultMsg = msg as SdkResultMessage
              log?.info("claude turn finished", {
                isError: resultMsg.is_error === true,
                subtype: resultMsg.subtype,
              })
            }
            for (const event of mapClaudeMessage(msg, state)) ctx.emit(event)
          }
          log?.info("claude sdk stream ended")
        } catch (err) {
          log?.error("claude pump errored", { detail: String(err) })
          // Swallow errors that are caused by tearing down the current query during a
          // restart or close — they must NOT emit runner-finished errored.
          if (closed || stale) return
          ctx.emit({
            type: "runner-finished",
            runnerId: ctx.rootRunnerId,
            status: "errored",
            error: String(err),
          })
        }
      })()

      return { query, inputStream, abort, markStale }
    }

    /**
     * Tear down the current query and relaunch with the current `currentMode` / `currentModel`.
     * The new query resumes the same claude session so history is preserved.
     */
    const restart = (): void => {
      if (closed) return
      // Mark the OLD launch stale BEFORE teardown so its pump's catch (which fires
      // asynchronously as a microtask) sees stale=true and does not emit errored.
      current.markStale()
      current.inputStream.end()
      current.abort.abort()
      current.query.close()
      current = launch(claudeSessionId)
    }

    // Launch with the initial permission mode + model, resuming if a resume id was supplied.
    current = launch(input.resume)
    // Seed the first turn from initialPrompt so the live session has something to do.
    // The prompt queue is drained asynchronously so pushing after launch() is safe.
    if (input.initialPrompt !== undefined)
      current.inputStream.push({ text: input.initialPrompt })

    return {
      // Task 6: build native content blocks (text + image/document base64) from
      // the turn + its attachments. text kinds become labeled text blocks and
      // binary kinds a text note — never an invalid image block.
      send: (turn) => {
        log?.info("claude turn -> sdk input", { length: turn.text.length })
        current.inputStream.push(turn)
        // Re-arm the no-response watchdog on every user turn.
        // Cancel any still-pending timer from a prior turn first.
        disarmWatchdog()
        awaitingResponse = true
        cancelWatchdog = setTimer(() => {
          if (awaitingResponse) {
            log?.warn("claude: no sdk response within timeout", {
              ms: responseTimeoutMs,
            })
          }
        }, responseTimeoutMs)
      },
      setMode: (mode) => {
        const native = toClaudePermissionMode(mode)
        currentMode = native
        // Capture the current query at the time of this setMode call.
        // This guards Finding 3: if a newer restart already happened by the time
        // the rejection fires, current.query !== q and we skip the stale restart.
        const q = current.query
        const attempt = current.query.setPermissionMode?.(native)
        if (attempt === undefined) {
          // SDK without live switching: relaunch with the new mode.
          // The absent-setPermissionMode path is synchronous; restart immediately regardless
          // of whether a session id exists (the new session will simply start fresh).
          restart()
        } else {
          attempt.catch(() => {
            // The SDK refuses some in-place switches (e.g. into bypassPermissions when the
            // process wasn't launched with --dangerously-skip-permissions): relaunch and
            // resume the same claude session with the new mode instead.
            // Guard (Finding 3): if a newer restart already replaced current.query, skip —
            // the new query will get its own setMode if the user switches again.
            if (current.query !== q) return
            // Guard (Finding 2): if system:init hasn't arrived yet we have no session id
            // to resume with, so the conversation would be silently dropped. Defer until
            // the session id is known; the pump picks it up after system:init.
            if (claudeSessionId === undefined) {
              pendingRestartMode = native
            } else {
              restart()
            }
          })
        }
      },
      setModel: (modelId, env) => {
        // Model is fixed per SDK query (the SDK reads `options.model` at query() time and
        // does not support a live-switch endpoint). To change models we relaunch resuming
        // the same claude session so conversation history is preserved.
        // null ⇒ switch back to "default" (no model): the SDK omits `model` and uses the
        // harness's own credentials. A provided env (the direct `{}`) replaces the proxy env
        // so the relaunched query drops ANTHROPIC_BASE_URL/_MODEL/_AUTH_TOKEN. Resume preserves history.
        // An optional env swaps the route — a direct-launched session becomes proxied
        // when a real model is picked, or a proxied session goes direct when null + {} is supplied.
        currentModel = modelId === null ? undefined : String(modelId)
        if (env !== undefined) currentEnv = env
        restart()
      },
      setThinkingEffort: (effort) => {
        // Thinking budget is fixed per SDK query (options are read at query() time).
        // Relaunch resuming the same claude session so history is preserved.
        currentEffort = effort
        restart()
      },
      interrupt: () => {
        // Drain any buffered-but-unsent turns so a rapid multi-send is fully
        // stopped, then interrupt the in-flight turn.
        current.inputStream.drain()
        void current.query.interrupt()
      },
      close: () => {
        if (closed) return
        closed = true
        disarmWatchdog()
        awaitingResponse = false
        current.inputStream.end()
        current.abort.abort()
        current.query.close()
      },
    }
  },
})
