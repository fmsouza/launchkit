import { describe, it, expect } from "bun:test"
import { createFixedClock, ok, err, type Result } from "@launchkit/utils"
import type { Provider } from "@launchkit/types"
import { createProviderTester } from "./provider-tester"
import { createScriptedGateway } from "./gateway"
import type { ProviderFactory, ModelHandle } from "./providers/factory"
import type { LanguageModelGateway } from "./gateway"
import type { NormalizedRequest, ProxyError, StreamEvent } from "./types"

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p_openai",
    name: "OpenAI",
    sdkProvider: "openai",
    config: {},
    secrets: {},
    models: ["gpt-4o"],
    ...over,
  }) as Provider

/** A factory fake that returns a fixed model handle (or a preset error). */
const fakeFactory = (result: Result<ModelHandle, ProxyError> = ok({})): ProviderFactory => ({
  getModel: async () => result,
})

/** A clock that advances by `stepMs` on each now() call, so elapsed time is deterministic. */
const steppingClock = (startMs: number, stepMs: number) => {
  let t = startMs
  return {
    now: (): Date => {
      const at = new Date(t)
      t += stepMs
      return at
    },
  }
}

describe("createProviderTester", () => {
  it("returns ok with the measured latency when the model streams a finish event", async () => {
    const gateway = createScriptedGateway([
      { type: "text-delta", text: "p" },
      { type: "finish", finishReason: "stop" },
    ])
    const tester = createProviderTester({ factory: fakeFactory(), gateway, clock: steppingClock(1000, 25) })

    const result = await tester(provider(), "gpt-4o")

    expect(result).toEqual({ ok: true, value: { ok: true, latencyMs: 25 } })
  })

  it("measures latency as the elapsed time between the first and last clock reads", async () => {
    const gateway = createScriptedGateway([{ type: "finish", finishReason: "stop" }])
    // first now()=2000 (start), second now()=2120 (end) → 120ms
    const tester = createProviderTester({ factory: fakeFactory(), gateway, clock: steppingClock(2000, 120) })

    const result = await tester(provider(), "gpt-4o")

    expect(result.ok && result.value.latencyMs).toBe(120)
  })

  it("sends a minimal one-token ping request to the gateway", async () => {
    const captured: NormalizedRequest[] = []
    const capturingGateway: LanguageModelGateway = {
      async *stream(_model: ModelHandle, req: NormalizedRequest): AsyncIterable<StreamEvent> {
        captured.push(req)
        yield { type: "finish", finishReason: "stop" }
      },
    }
    const tester = createProviderTester({
      factory: fakeFactory(),
      gateway: capturingGateway,
      clock: createFixedClock(new Date("2026-05-23T00:00:00.000Z")),
    })

    await tester(provider(), "gpt-4o")

    expect(captured).toHaveLength(1)
    expect(captured[0]?.maxTokens).toBe(1)
    expect(captured[0]?.messages).toEqual([{ role: "user", content: "ping" }])
    expect(captured[0]?.stream).toBe(true)
  })

  it("returns ok:false when the provider factory fails to build a model", async () => {
    const gateway = createScriptedGateway([{ type: "finish", finishReason: "stop" }])
    const tester = createProviderTester({
      factory: fakeFactory(err({ kind: "provider-failed", detail: "secret apiKey unavailable" })),
      gateway,
      clock: steppingClock(0, 10),
    })

    const result = await tester(provider(), "gpt-4o")

    expect(result).toEqual({ ok: true, value: { ok: false, latencyMs: 0 } })
  })

  it("returns ok:false when the stream yields an error event", async () => {
    const gateway = createScriptedGateway([{ type: "error", detail: "401 from upstream" }])
    const tester = createProviderTester({ factory: fakeFactory(), gateway, clock: steppingClock(500, 40) })

    const result = await tester(provider(), "gpt-4o")

    expect(result.ok && result.value).toEqual({ ok: false, latencyMs: 40 })
  })
})
