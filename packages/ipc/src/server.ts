import type { z } from "zod"
import type { IpcError } from "./errors"
import { IpcMethodSchemas, type IpcMethodName, type IpcMethods } from "./methods"

/** The injected inbound bus the server listens on (Electrobun in production). */
export interface ServerTransport {
  onRequest(handler: (method: string, payload: unknown) => Promise<unknown>): void
}

/** One handler per method: typed params in, typed result out. */
export type IpcHandlers = {
  readonly [K in IpcMethodName]: (params: IpcMethods[K]["params"]) => Promise<IpcMethods[K]["result"]>
}

const isMethodName = (method: string): method is IpcMethodName =>
  Object.prototype.hasOwnProperty.call(IpcMethodSchemas, method)

/**
 * A surfaced IPC failure. Carries the typed `IpcError`; its message is
 * `"<kind>: <detail>"` so transports/tests can pattern-match on the kind
 * without leaking stack traces or secrets.
 */
export class IpcRequestError extends Error {
  readonly ipcError: IpcError
  constructor(ipcError: IpcError) {
    super(`${ipcError.kind}: ${ipcError.detail}`)
    this.name = "IpcRequestError"
    this.ipcError = ipcError
  }
}

const toDetail = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Wire a set of handlers to an injected inbound transport. Each request is
 * (1) routed to a known method, (2) param-validated before dispatch, (3) run,
 * (4) result-validated before reply. Any failure is thrown as an
 * `IpcRequestError` carrying a typed `IpcError` for the transport to serialize.
 */
export const createIpcServer = (handlers: IpcHandlers, transport: ServerTransport): void => {
  transport.onRequest(async (method: string, payload: unknown): Promise<unknown> => {
    // 1. Route — unknown methods are rejected, never guessed.
    if (!isMethodName(method)) {
      throw new IpcRequestError({ kind: "handler-failed", detail: `unknown method: ${method}` })
    }
    const schemas = IpcMethodSchemas[method]

    // 2. Validate the incoming payload BEFORE the handler can observe it.
    const parsedParams = (schemas.params as z.ZodTypeAny).safeParse(payload)
    if (!parsedParams.success) {
      throw new IpcRequestError({ kind: "validation-failed", detail: parsedParams.error.message })
    }

    // 3. Dispatch — handler faults become typed handler-failed errors.
    let result: unknown
    try {
      const handler = handlers[method] as (p: unknown) => Promise<unknown>
      result = await handler(parsedParams.data)
    } catch (e) {
      throw new IpcRequestError({ kind: "handler-failed", detail: toDetail(e) })
    }

    // 4. Validate/serialize the result before it leaves the main process.
    const parsedResult = (schemas.result as z.ZodTypeAny).safeParse(result)
    if (!parsedResult.success) {
      throw new IpcRequestError({ kind: "validation-failed", detail: parsedResult.error.message })
    }
    return parsedResult.data
  })
}
