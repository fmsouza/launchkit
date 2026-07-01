import { z } from "zod"

/**
 * The OpenCode SSE event envelope (opencode.ai/docs/server; sdk types.gen.ts). A union over the `type`
 * string. `.passthrough()` tolerates the infra fields the server adds that the mapper ignores; the
 * discriminant `type` + the fields the mapper reads are validated. We model only the events the adapter
 * consumes; an unknown `type` string is rejected (the live stream is already typed `OpencodeEvent`, so the
 * schema's job is to validate the recorded fixtures + reject malformed frames).
 */
const messageInfo = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.enum(["user", "assistant"]),
  })
  .passthrough()

// A Part is a union on `type`; we validate the two the mapper reads (text, tool) and tolerate the rest
// via passthrough on a base shape.
const textPart = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough()

const toolState = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("pending"), input: z.unknown().optional() })
    .passthrough(),
  z
    .object({
      status: z.literal("running"),
      input: z.unknown().optional(),
      title: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      status: z.literal("completed"),
      input: z.unknown().optional(),
      output: z.string(),
      title: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      status: z.literal("error"),
      input: z.unknown().optional(),
      error: z.string(),
    })
    .passthrough(),
])

const toolPart = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: toolState,
  })
  .passthrough()

// Any other part type (reasoning/file/agent/step-*/…) — tolerated, mapped to [] by mapOpencodeEvent.
// Enumerated as literals (Research §6) so the `part` union stays a proper discriminated union (TS
// narrows on `part.type`); a never-seen part type would simply fail this arm and the schema as a whole.
const otherPart = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.enum([
      "reasoning",
      "file",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "compaction",
    ]),
  })
  .passthrough()

const part = z.discriminatedUnion("type", [textPart, toolPart, otherPart])

const sessionInfo = z
  .object({
    id: z.string(),
    parentID: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough()

export const OpencodeEventSchema = z.union([
  z.object({
    type: z.literal("message.updated"),
    properties: z.object({ info: messageInfo }).passthrough(),
  }),
  z.object({
    type: z.literal("message.part.updated"),
    properties: z.object({ part, delta: z.string().optional() }).passthrough(),
  }),
  z.object({
    type: z.literal("session.idle"),
    properties: z.object({ sessionID: z.string() }).passthrough(),
  }),
  z.object({
    type: z.literal("permission.updated"),
    properties: z
      .object({
        id: z.string(),
        type: z.string(),
        sessionID: z.string(),
        messageID: z.string().optional(),
        callID: z.string().optional(),
        pattern: z.union([z.string(), z.array(z.string())]).optional(),
        title: z.string(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal("permission.replied"),
    properties: z
      .object({
        sessionID: z.string(),
        permissionID: z.string(),
        response: z.string(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.enum(["session.created", "session.updated", "session.deleted"]),
    properties: z.object({ info: sessionInfo }).passthrough(),
  }),
  z.object({
    type: z.literal("session.error"),
    properties: z
      .object({ info: sessionInfo.optional(), error: z.unknown().optional() })
      .passthrough(),
  }),
])
export type OpencodeEvent = z.infer<typeof OpencodeEventSchema>

/** A subscribed SSE stream handle (SDK `await client.event.subscribe()` → `{ stream }`). */
export interface OpencodeEventStream {
  readonly stream: AsyncIterable<OpencodeEvent>
}

/** The reduced OpenCode client surface the adapter needs (SDK `createOpencodeClient(...)` shape). */
export interface OpencodeClient {
  readonly session: {
    /** Create a session (REST POST /session). parentID marks a child/subagent session. */
    create(args: {
      readonly body: { readonly parentID?: string; readonly title?: string }
    }): Promise<{ readonly id: string }>
    /** Send a user turn (REST POST /session/:id/message). */
    prompt(args: {
      readonly path: { readonly id: string }
      readonly body: {
        readonly parts: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | {
              readonly type: "file"
              readonly mime: string
              readonly url: string
              readonly filename?: string
            }
        >
        /** OpenCode agent to invoke (e.g. "plan"). Accepted by SDK SessionPromptData.body.agent. */
        readonly agent?: string
      }
    }): Promise<unknown>
    /** Abort the current turn (REST POST /session/:id/abort). */
    abort(args: { readonly path: { readonly id: string } }): Promise<unknown>
    /** Reply to a permission (REST POST /session/:id/permissions/:permissionID). */
    permissions(args: {
      readonly path: { readonly id: string; readonly permissionID: string }
      readonly body: { readonly response: "once" | "always" | "reject" }
    }): Promise<unknown>
  }
  readonly event: {
    /** Subscribe the GLOBAL SSE bus (server-wide; the adapter filters by sessionID). */
    subscribe(): Promise<OpencodeEventStream>
  }
}

/** The running `opencode serve` process handle (SDK `createOpencode()`/`createOpencodeServer()`). */
export interface OpencodeServer {
  readonly url: string
  close(): void
}

/**
 * A minimal `opencode` config declaring a single OpenAI-compatible provider pointed at the Spectrum
 * proxy (a typed subset of the SDK's `Config`). The SDK serializes this into `OPENCODE_CONFIG_CONTENT`
 * for the spawned `opencode serve`, so it is how the per-run proxy reaches the server — `createOpencode`
 * exposes no `env` option, and `opencode serve` is spawned with the parent `process.env` only.
 */
export interface OpencodeProxyConfig {
  readonly provider: {
    readonly spectrum: {
      readonly npm: string
      readonly name: string
      readonly options: { readonly baseURL: string; readonly apiKey?: string }
      readonly models: Readonly<Record<string, Readonly<Record<string, never>>>>
    }
  }
  readonly model: string
}

/**
 * Build an `OpencodeProxyConfig` from the rendered proxy env (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/
 * `OPENAI_MODEL`). Returns `undefined` for the direct (non-proxied) route where those are absent, so the
 * server falls back to opencode's own provider config. PURE.
 */
export const buildOpencodeProxyConfig = (
  env: Readonly<Record<string, string>>,
): OpencodeProxyConfig | undefined => {
  const baseURL = env.OPENAI_BASE_URL
  const model = env.OPENAI_MODEL
  if (baseURL === undefined || model === undefined) return undefined
  const apiKey = env.OPENAI_API_KEY
  return {
    provider: {
      spectrum: {
        npm: "@ai-sdk/openai-compatible",
        name: "Spectrum",
        options: { baseURL, ...(apiKey !== undefined ? { apiKey } : {}) },
        models: { [model]: {} },
      },
    },
    model: `spectrum/${model}`,
  }
}

/** The connection target rendered from AgentStartInput (cwd + optional explicit baseUrl/port + proxy config). */
export interface OpencodeConnectConfig {
  readonly cwd: string
  /** Optional pre-running server base URL; when absent, the connector starts `opencode serve` on loopback. */
  readonly baseUrl?: string
  readonly port?: number
  readonly env: Readonly<Record<string, string>>
  /** The proxy provider config injected into the spawned server (absent on the direct route). */
  readonly config?: OpencodeProxyConfig
}

/**
 * Start (or connect to) an `opencode serve` instance and return a client + an optional server handle.
 * Injected so the adapter is testable with a fake. The real impl wraps `@opencode-ai/sdk` (`createOpencode`
 * / `createOpencodeClient`); it is the ONE seam exercised by the app-run smoke (Task 7).
 */
export type OpencodeConnect = (config: OpencodeConnectConfig) => Promise<{
  readonly client: OpencodeClient
  readonly server?: OpencodeServer
}>
