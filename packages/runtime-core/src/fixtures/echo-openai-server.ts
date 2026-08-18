/**
 * Test fixture: the smallest possible plugin-contributed provider server.
 *
 * Spawned as a REAL child process by `extension-provider.integration.test.ts` through the same
 * manifest → registry → provider-host path a shipped plugin takes. Reads `--port` from argv and
 * echoes `process.env.SPECTRUM_TOKEN` in the `x-spectrum-host-token` header on every response —
 * that echo is what `waitForReady` checks to prove the process on that port is the one Spectrum
 * spawned.
 *
 * WIRE: a contribution declaring `wire: "openai"` is built with `createOpenAI(...)(modelId)`,
 * which in AI SDK v6 is the **Responses** API (`POST /responses`), not chat completions — the same
 * request the builtin "Custom (OpenAI-compatible)" provider makes. This fixture therefore serves
 * `/responses`, because that is what the runtime actually sends.
 *
 * Routes sit at the ROOT of the base url (`/models`, `/responses`): the provider host hands the
 * factory a bare `http://127.0.0.1:<port>`, and both `@ai-sdk/openai` and the model lister append
 * their paths to it. A `/v1` prefix is accepted too, so a manifest may point `healthPath` at either.
 */
// Marks this file a MODULE. A fixture with no import or export is a global SCRIPT to
// TypeScript, and its top-level `const`s then collide with the identically-named ones in every
// sibling fixture — `tsc` fails the whole package with "cannot redeclare". Any fixture added
// next to these needs the same line.
export {}

const portIndex = Bun.argv.indexOf("--port")
const port = Number(Bun.argv[portIndex + 1])
const token = process.env.SPECTRUM_TOKEN ?? ""

/**
 * Optional path this fixture touches the FIRST time it answers a health request. Its existence is
 * proof that Spectrum's readiness probe reached this process and got a reply — which is what lets
 * the wrong-token case assert that readiness refused because of the TOKEN, not because the server
 * never bound in time.
 */
const readyMarker = process.env.SPECTRUM_READY_MARKER ?? ""
let markerWritten = false

const noteProbed = (): void => {
  if (readyMarker === "" || markerWritten) return
  markerWritten = true
  void Bun.write(readyMarker, `probed on ${port}\n`)
}

const withToken = (response: Response): Response => {
  response.headers.set("x-spectrum-host-token", token)
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
          model: "echo-1",
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

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req): Response {
    const path = new URL(req.url).pathname.replace(/^\/v1(?=\/|$)/, "")

    if (path === "/models") {
      noteProbed()
      return withToken(
        Response.json({ data: [{ id: "echo-1", object: "model" }] }),
      )
    }

    if (path === "/responses")
      return withToken(
        new Response(responsesStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
      )

    return withToken(new Response("not found", { status: 404 }))
  },
})
