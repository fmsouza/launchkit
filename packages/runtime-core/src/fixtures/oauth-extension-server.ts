/**
 * Test fixture: a plugin-contributed provider server that ALSO serves an OAuth-shaped setup
 * flow, plus the fake identity provider the flow redirects to. One process, no network.
 *
 * Spawned as a REAL child by `extension-flow.integration.test.ts` through the same manifest →
 * registry → provider-host path a shipped plugin takes. Reads `--port` from argv and echoes
 * `process.env.SPECTRUM_TOKEN` in the `x-spectrum-host-token` header on every response — that
 * echo is what `waitForReady` checks to prove the process on that port is the one Spectrum
 * spawned.
 *
 * THIS FIXTURE REJECTS. It is the only place in the plan that sees the bytes Spectrum's real
 * flow client puts on the wire, so it validates them instead of accepting whatever arrives:
 *
 * - every flow request must carry `x-spectrum-host-token` matching this process's own token,
 *   or it is answered `401` — a fixture that ignored the header would pass just as happily
 *   against a client that never sent one;
 * - `start` must carry `{ context, config }` and `next` must carry `{ sessionId, result }`,
 *   or the request is answered `400`; and the `sessionId` must be one THIS process minted,
 *   which is what makes a client that echoed Spectrum's own session id fail loudly.
 *
 * Neither `401` nor `400` is a body a `FlowResponse` can parse, and the flow client fails a
 * non-2xx status before it ever reads the body, so every refusal surfaces as a failed step.
 *
 * WIRE: routes sit at the ROOT of the base url (`/models`, `/responses`), because the provider
 * host hands the factory a bare `http://127.0.0.1:<port>`. `wire: "openai"` means AI SDK v6's
 * **Responses** API (`POST /responses`), as in `echo-openai-server.ts`. The flow endpoints are
 * spelled out literally, exactly as a third-party plugin author would hardcode them — a drift
 * in `FLOW_PATH_PREFIX` must show up here as a 404, not be silently absorbed.
 */
// Marks this file a MODULE. A fixture with no import or export is a global SCRIPT to
// TypeScript, and its top-level `const`s then collide with the identically-named ones in
// `echo-openai-server.ts` — `tsc` fails the whole package with "cannot redeclare". Any third
// fixture added next to these needs the same line.
export {}

const portIndex = Bun.argv.indexOf("--port")
const port = Number(Bun.argv[portIndex + 1])

/** Minted by Spectrum for THIS child; proves both directions of the loopback handshake. */
const token = process.env.SPECTRUM_TOKEN ?? ""

/**
 * The credential this fake identity provider hands out when the flow completes, and the value
 * a later serving child must receive back in `SPECTRUM_API_KEY` for `/models` to list the real
 * model. Supplied by the manifest as a literal so the fixture hardcodes no secret of its own
 * and the test owns the value end to end.
 */
const grantedApiKey = process.env.SPECTRUM_GRANTED_API_KEY ?? ""
/** The non-secret config value the flow returns alongside the credential. */
const grantedAccountId = process.env.SPECTRUM_GRANTED_ACCOUNT_ID ?? ""
/** Rendered from the provider record's resolved secrets — empty for a flow's own child. */
const apiKey = process.env.SPECTRUM_API_KEY ?? ""

const HOST_TOKEN_HEADER = "x-spectrum-host-token"
const FLOW_PREFIX = "/spectrum/v1/flow/"

const withToken = (response: Response): Response => {
  response.headers.set(HOST_TOKEN_HEADER, token)
  return response
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

/** One text delta ("hello") plus the framing events the Responses stream parser requires. */
const responsesStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller): void {
      const enc = new TextEncoder()
      const send = (payload: unknown): void => {
        controller.enqueue(enc.encode(sse(payload)))
      }
      send({
        type: "response.created",
        response: {
          id: "resp_1",
          created_at: Math.floor(Date.now() / 1000),
          model: "oauth-1",
        },
      })
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      })
      send({
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "hello",
      })
      send({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      })
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

/** One exchange this process is driving: which flow, and the state it handed the browser. */
type FlowSession = { readonly flowId: string; readonly state: string }

const sessions = new Map<string, FlowSession>()
/** States whose consent redirect has been received — the browser half of the handshake. */
const consented = new Set<string>()
let seq = 0

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const flowJson = (payload: unknown): Response =>
  withToken(Response.json(payload))

const refuse = (status: number, detail: string): Response =>
  withToken(Response.json({ error: detail }, { status }))

/**
 * A step that never terminates, for the flow whose cap the runner has to enforce.
 *
 * `pollMs` is deliberately BELOW Spectrum's floor: a plugin that asks to be polled every 10 ms
 * is how a UI gets pinned to a plugin's chosen rate, and the runner's clamp is only observable
 * from the outside if the number it clamps is not already a legal one.
 */
const awaitStep = (title: string): Record<string, unknown> => ({
  kind: "await",
  title,
  pollMs: 10,
})

const handleStart = (flowId: string, body: unknown): Response => {
  // `{ context, config }` is exactly what the runner's `start` promises to send. A fixture
  // that skipped this would accept an empty body and prove nothing about the client.
  if (!isRecord(body)) return refuse(400, "start body must be an object")
  const context = body.context
  if (context !== "create" && context !== "provider")
    return refuse(400, "start body needs a create/provider context")
  if (!isRecord(body.config)) return refuse(400, "start body needs a config")

  seq += 1
  const sessionId = `plugin-session-${seq}`
  const state = `state-${seq}`
  sessions.set(sessionId, { flowId, state })

  // Every flow id opens the same way, so a test always learns this child's port from the url
  // it is asked to open. What each flow does afterwards is `handleNext`'s business: "signin"
  // finishes, "endless" never stops producing steps, "hang" never answers at all.
  return flowJson({
    sessionId,
    step: {
      kind: "open-external",
      title: "Authorize Spectrum",
      description: "Finish signing in with the demo identity provider.",
      url: `http://127.0.0.1:${port}/fake-idp?state=${state}`,
    },
    toast: { tone: "info", message: "Opening your browser" },
  })
}

const handleNext = async (flowId: string, body: unknown): Promise<Response> => {
  if (!isRecord(body)) return refuse(400, "next body must be an object")
  const sessionId = body.sessionId
  // Spectrum mints its OWN session id and must never send it here. Refusing an id this
  // process did not mint is what turns that confusion into a failed test.
  if (typeof sessionId !== "string" || !sessions.has(sessionId))
    return refuse(400, "next body needs a session id this plugin minted")
  const result = body.result
  if (!isRecord(result) || typeof result.kind !== "string")
    return refuse(400, "next body needs a result")

  const session = sessions.get(sessionId)
  if (session === undefined || session.flowId !== flowId)
    return refuse(400, "session belongs to another flow")

  // Never answers. The runner's armed deadline is the only thing that can end this flow.
  if (flowId === "hang") return await new Promise<Response>(() => {})

  if (flowId === "endless")
    return flowJson({ sessionId, step: awaitStep("Never finishing") })

  if (!consented.has(session.state))
    return flowJson({
      sessionId,
      step: awaitStep("Waiting for authorization"),
    })

  return flowJson({
    sessionId,
    step: {
      kind: "done",
      message: "Signed in",
      config: { accountId: grantedAccountId },
      secrets: { apiKey: grantedApiKey },
    },
    toast: { tone: "success", message: "Signed in" },
  })
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "")

    if (path === "/models")
      return withToken(
        Response.json({
          // The id is the RECEIVED credential's verdict: a serving child started with the key
          // the flow granted lists the real model, one started without it does not. That makes
          // "the flow's secret reached this process's environment" an assertion the test can
          // make from the outside, without trusting anything the fixture says about itself.
          data: [
            {
              id:
                grantedApiKey !== "" && apiKey === grantedApiKey
                  ? "oauth-1"
                  : "unauthenticated",
              object: "model",
            },
          ],
        }),
      )

    // Lets the test learn which OS process this child is, so "the flow stopped its instance"
    // can be checked against the process table instead of against Spectrum's own bookkeeping.
    if (path === "/pid") return withToken(Response.json({ pid: process.pid }))

    if (path === "/fake-idp") {
      // Stands in for the user completing consent in a browser.
      const state = url.searchParams.get("state") ?? ""
      if (state === "") return refuse(400, "the redirect carried no state")
      consented.add(state)
      return withToken(new Response("you may close this window"))
    }

    if (path === "/responses")
      return withToken(
        new Response(responsesStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
      )

    if (path.startsWith(FLOW_PREFIX)) {
      // A plugin's flow endpoints are privileged: they mint and hand back credentials. Anything
      // that cannot present the token Spectrum minted for THIS child is another local process.
      if (token === "" || req.headers.get(HOST_TOKEN_HEADER) !== token)
        return refuse(401, "missing or wrong host token")

      const rest = path.slice(FLOW_PREFIX.length).split("/")
      const flowId = rest[0] ?? ""
      const op = rest[1] ?? ""
      if (flowId === "" || rest.length !== 2)
        return refuse(404, "no such flow endpoint")

      const body: unknown = await req.json().catch(() => undefined)
      if (op === "start") return handleStart(flowId, body)
      if (op === "next") return await handleNext(flowId, body)
      return refuse(404, "no such flow operation")
    }

    return withToken(new Response("not found", { status: 404 }))
  },
})
