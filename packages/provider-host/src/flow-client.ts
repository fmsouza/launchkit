import type { FlowResponse, PluginError } from "@spectrum/extensions"
import {
  FLOW_LIMITS,
  FLOW_PATH_PREFIX,
  FlowResponseSchema,
} from "@spectrum/extensions"
import { type Result, err, ok } from "@spectrum/utils"
import { HOST_TOKEN_HEADER } from "./host-token"

export type FlowHttp = (input: {
  url: string
  body: unknown
  hostToken: string | undefined
  /**
   * How long this one call may take. The caller passes what is left of the flow's total
   * budget: a plugin that accepts the connection and never answers would otherwise hang the
   * call forever, and the runner's budget is only re-read when a call returns.
   */
  timeoutMs: number
}) => Promise<Result<unknown, PluginError>>

/** The slice of `fetch` this adapter uses, injectable so the deadline itself is testable. */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<Response>

/**
 * Enforces `FLOW_LIMITS.maxBodyBytes` by reading the response body as a stream and aborting
 * past the cap, rather than buffering whatever a hostile or hung plugin sends first. A
 * non-2xx status fails before the body is ever read, so an error page never reaches the
 * parser. `timeoutMs` aborts the request and the body read alike, so a plugin that accepts
 * the connection and never answers cannot hang the caller.
 *
 * The abort is an explicit controller rather than `AbortSignal.timeout` so the timer is
 * cleared the moment the call settles instead of lingering for the rest of the budget.
 */
export const createFetchFlowHttp = (deps?: {
  readonly fetch?: FetchLike
}): FlowHttp => {
  const send: FetchLike = deps?.fetch ?? ((url, init) => fetch(url, init))
  return async ({ url, body, hostToken, timeoutMs }) => {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (hostToken !== undefined) headers[HOST_TOKEN_HEADER] = hostToken

      // The signal aborts the streamed body read below as well as the request itself, so a
      // plugin that answers headers and then dribbles cannot outlive the deadline either.
      const response = await send(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok)
        return err({
          kind: "read-failed",
          detail: `unexpected status ${response.status}`,
        })

      if (!response.body)
        return err({ kind: "read-failed", detail: "empty response body" })

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > FLOW_LIMITS.maxBodyBytes) {
          await reader.cancel()
          return err({
            kind: "read-failed",
            detail: "response body exceeded the size cap",
          })
        }
        chunks.push(value)
      }

      const text = Buffer.concat(chunks).toString("utf8")
      return ok(JSON.parse(text) as unknown)
    } catch (cause) {
      return err({
        kind: "read-failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      clearTimeout(deadline)
    }
  }
}

/** `timeoutMs` is the caller's remaining budget for the whole flow, not a per-op constant. */
export type FlowClient = {
  start(
    baseUrl: string,
    hostToken: string | undefined,
    flowId: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Result<FlowResponse, PluginError>>
  next(
    baseUrl: string,
    hostToken: string | undefined,
    flowId: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Result<FlowResponse, PluginError>>
}

const call = async (
  http: FlowHttp,
  op: "start" | "next",
  baseUrl: string,
  hostToken: string | undefined,
  flowId: string,
  body: unknown,
  timeoutMs: number,
): Promise<Result<FlowResponse, PluginError>> => {
  const url = `${baseUrl.replace(/\/$/, "")}${FLOW_PATH_PREFIX}/${flowId}/${op}`
  const result = await http({ url, body, hostToken, timeoutMs })
  if (!result.ok) return result

  // A flow response is external input from a separate process — validate before trusting
  // the step kind. An unknown kind is a contract violation by the extension; the runner
  // turns this into the user-facing "this step needs a newer Spectrum".
  const parsed = FlowResponseSchema.safeParse(result.value)
  if (!parsed.success)
    return err({ kind: "invalid-manifest", detail: parsed.error.message })
  return ok(parsed.data)
}

export const createFlowClient = (deps: { http: FlowHttp }): FlowClient => ({
  start: (baseUrl, hostToken, flowId, body, timeoutMs) =>
    call(deps.http, "start", baseUrl, hostToken, flowId, body, timeoutMs),
  next: (baseUrl, hostToken, flowId, body, timeoutMs) =>
    call(deps.http, "next", baseUrl, hostToken, flowId, body, timeoutMs),
})
