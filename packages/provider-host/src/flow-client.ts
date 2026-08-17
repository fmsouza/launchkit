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
}) => Promise<Result<unknown, PluginError>>

/**
 * Enforces `FLOW_LIMITS.maxBodyBytes` by reading the response body as a stream and aborting
 * past the cap, rather than buffering whatever a hostile or hung plugin sends first. A
 * non-2xx status fails before the body is ever read, so an error page never reaches the
 * parser.
 */
export const createFetchFlowHttp = (): FlowHttp => {
  return async ({ url, body, hostToken }) => {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (hostToken !== undefined) headers[HOST_TOKEN_HEADER] = hostToken

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
    }
  }
}

export type FlowClient = {
  start(
    baseUrl: string,
    hostToken: string | undefined,
    flowId: string,
    body: unknown,
  ): Promise<Result<FlowResponse, PluginError>>
  next(
    baseUrl: string,
    hostToken: string | undefined,
    flowId: string,
    body: unknown,
  ): Promise<Result<FlowResponse, PluginError>>
}

const call = async (
  http: FlowHttp,
  op: "start" | "next",
  baseUrl: string,
  hostToken: string | undefined,
  flowId: string,
  body: unknown,
): Promise<Result<FlowResponse, PluginError>> => {
  const url = `${baseUrl.replace(/\/$/, "")}${FLOW_PATH_PREFIX}/${flowId}/${op}`
  const result = await http({ url, body, hostToken })
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
  start: (baseUrl, hostToken, flowId, body) =>
    call(deps.http, "start", baseUrl, hostToken, flowId, body),
  next: (baseUrl, hostToken, flowId, body) =>
    call(deps.http, "next", baseUrl, hostToken, flowId, body),
})
