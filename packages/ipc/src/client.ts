import type { z } from "zod"
import { type Result, ok, err } from "@launchkit/utils"
import type { IpcError } from "./errors"
import { IpcMethodSchemas, type IpcMethodName, type IpcMethods } from "./methods"

/** The injected message bus the client sends over (Electrobun in production). */
export interface ClientTransport {
  send(method: string, payload: unknown): Promise<unknown>
}

const toDetail = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A typed client method: validated params in, `Result<result, IpcError>` out. */
type ClientMethod<K extends IpcMethodName> = (
  params: IpcMethods[K]["params"],
) => Promise<Result<IpcMethods[K]["result"], IpcError>>

export type IpcClient = { readonly [K in IpcMethodName]: ClientMethod<K> }

const callMethod = async <K extends IpcMethodName>(
  transport: ClientTransport,
  method: K,
  params: IpcMethods[K]["params"],
): Promise<Result<IpcMethods[K]["result"], IpcError>> => {
  const schemas = IpcMethodSchemas[method]

  // 1. Validate params on the way out (defense even though TS-typed).
  const parsedParams = (schemas.params as z.ZodTypeAny).safeParse(params)
  if (!parsedParams.success) {
    return err({ kind: "validation-failed", detail: parsedParams.error.message })
  }

  // 2. Send over the injected transport; transport faults are values, not throws.
  let raw: unknown
  try {
    raw = await transport.send(method, parsedParams.data)
  } catch (e) {
    return err({ kind: "transport-failed", detail: toDetail(e) })
  }

  // 3. Validate the response against the result schema before trusting it.
  const parsedResult = (schemas.result as z.ZodTypeAny).safeParse(raw)
  if (!parsedResult.success) {
    return err({ kind: "validation-failed", detail: parsedResult.error.message })
  }
  return ok(parsedResult.data as IpcMethods[K]["result"])
}

/**
 * Build a typed IPC client over an injected transport. Each generated method
 * validates its params, sends, then validates the response — returning a
 * `Result` and never throwing.
 */
export const createIpcClient = (transport: ClientTransport): IpcClient => {
  const names = Object.keys(IpcMethodSchemas) as IpcMethodName[]
  const client = {} as Record<IpcMethodName, ClientMethod<IpcMethodName>>
  for (const name of names) {
    client[name] = ((params: IpcMethods[typeof name]["params"]) =>
      callMethod(transport, name, params)) as ClientMethod<IpcMethodName>
  }
  return client as IpcClient
}
