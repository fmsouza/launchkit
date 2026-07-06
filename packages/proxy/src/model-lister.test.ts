import { describe, expect, it } from "bun:test"
import type { SdkProvider } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import { createModelLister } from "./model-lister"
import type { HttpGet } from "./model-lister"
import type { ProxyError } from "./types"

// ── Fake HttpGet ─────────────────────────────────────────────────────────────

/** Builds an HttpGet fake that returns the canned body for any URL. */
const fakeHttpGet =
  (
    body: Result<unknown, ProxyError>,
    captureHeaders?: (
      headers: Readonly<Record<string, string>> | undefined,
    ) => void,
  ): HttpGet =>
  async (
    _url: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<Result<unknown, ProxyError>> => {
    if (captureHeaders) captureHeaders(headers)
    return body
  }

/** Builds an HttpGet fake that captures each call's url and headers for assertions. */
const capturingHttpGet = (
  body: Result<unknown, ProxyError>,
): {
  httpGet: HttpGet
  calls: Array<{
    url: string
    headers: Readonly<Record<string, string>> | undefined
  }>
} => {
  const calls: Array<{
    url: string
    headers: Readonly<Record<string, string>> | undefined
  }> = []
  const httpGet: HttpGet = async (url, headers) => {
    calls.push({ url, headers })
    return body
  }
  return { httpGet, calls }
}

// ── ollama (cloud) ────────────────────────────────────────────────────────────

describe("createModelLister – ollama (cloud)", () => {
  it("returns model names from /tags response", async () => {
    const body = {
      models: [
        { name: "llama3.2", digest: "abc" },
        { name: "mistral:latest", digest: "def" },
      ],
    }
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok(body)),
    })

    const result = await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "k1",
    })

    expect(result).toEqual({
      ok: true,
      value: [{ id: "llama3.2" }, { id: "mistral:latest" }],
    })
  })

  it("uses the default ollama cloud base URL when config has no serverUrl", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ models: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "k",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://ollama.com/api/tags")
  })

  it("uses serverUrl from config when provided", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ models: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: { serverUrl: "https://my-ollama-cloud.example.com/api" },
      apiKey: "k",
    })

    expect(calls[0]?.url).toBe("https://my-ollama-cloud.example.com/api/tags")
  })

  it("sends Authorization header for ollama cloud", async () => {
    const capturedHeaders: Array<Readonly<Record<string, string>> | undefined> =
      []
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ models: [] }), (h) => capturedHeaders.push(h)),
    })

    await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "my-cloud-key",
    })

    const h = capturedHeaders[0]
    expect(h?.Authorization).toBe("Bearer my-cloud-key")
  })

  it("returns err on http error for ollama", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(
        err({ kind: "provider-failed", detail: "connection refused" }),
      ),
    })

    const result = await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "k",
    })

    expect(result.ok).toBe(false)
  })

  it("returns err when ollama response has no models field", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ wrong: "shape" })),
    })

    const result = await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "k",
    })

    expect(result.ok).toBe(false)
  })

  it("returns err when ollama models items have no name field", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ models: [{ digest: "abc" }] })),
    })

    const result = await lister({
      sdkProvider: "ollama" as SdkProvider,
      config: {},
      apiKey: "k",
    })

    expect(result.ok).toBe(false)
  })
})

// ── OpenAI-compatible ─────────────────────────────────────────────────────────

describe("createModelLister – openai", () => {
  it("returns model ids from /v1/models response", async () => {
    const body = {
      data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    }
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok(body)),
    })

    const result = await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-test",
    })

    expect(result).toEqual({
      ok: true,
      value: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    })
  })

  it("sends Bearer token in Authorization header", async () => {
    const capturedHeaders: Array<Readonly<Record<string, string>> | undefined> =
      []
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ data: [] }), (h) => capturedHeaders.push(h)),
    })

    await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-my-key",
    })

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer sk-my-key")
  })

  it("uses the default openai base URL when config has no baseUrl", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ data: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-x",
    })

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models")
  })

  it("uses serverUrl from config for openai-compatible provider", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ data: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "groq" as SdkProvider,
      config: { serverUrl: "https://api.groq.com/openai/v1" },
      apiKey: "gsk-key",
    })

    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models")
  })

  it("returns err on http error for openai", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(
        err({ kind: "provider-failed", detail: "401 Unauthorized" }),
      ),
    })

    const result = await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-bad",
    })

    expect(result.ok).toBe(false)
  })

  it("returns err when openai response has no data field", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ wrong: "shape" })),
    })

    const result = await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-x",
    })

    expect(result.ok).toBe(false)
  })

  it("returns err when openai data items have no id field", async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({ data: [{ name: "gpt-4o" }] })),
    })

    const result = await lister({
      sdkProvider: "openai" as SdkProvider,
      config: {},
      apiKey: "sk-x",
    })

    expect(result.ok).toBe(false)
  })
})

// ── OpenAI-compatible variants ────────────────────────────────────────────────

describe.each([
  "groq",
  "xai",
  "fireworks",
  "perplexity",
  "cerebras",
  "mistral",
  "cohere",
] as SdkProvider[])(
  "createModelLister – %s (openai-compatible)",
  (sdkProvider) => {
    it(`returns model ids via /v1/models for ${sdkProvider}`, async () => {
      const lister = createModelLister({
        httpGet: fakeHttpGet(ok({ data: [{ id: "model-a" }] })),
      })

      const result = await lister({
        sdkProvider,
        config: {},
        apiKey: "key-for-test",
      })

      expect(result).toEqual({ ok: true, value: [{ id: "model-a" }] })
    })
  },
)

// ── OpenAI-compatible default base URLs ───────────────────────────────────────

describe("createModelLister – default base URL resolution", () => {
  it("uses the default groq base URL when config has no baseUrl", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ data: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "groq" as SdkProvider,
      config: {},
      apiKey: "gsk-test",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models")
  })

  it("uses the default mistral base URL when config has no baseUrl", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ data: [] }))
    const lister = createModelLister({ httpGet })

    await lister({
      sdkProvider: "mistral" as SdkProvider,
      config: {},
      apiKey: "mist-test",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/models")
  })

  it("returns err and does NOT call the fetcher when the resolved base is empty", async () => {
    const { httpGet, calls } = capturingHttpGet(ok({ data: [] }))
    const lister = createModelLister({ httpGet })

    // custom has no defaultBaseUrl, and an explicit empty serverUrl collapses to "".
    // The lister must guard this and error without hitting the network.
    const result = await lister({
      sdkProvider: "custom" as SdkProvider,
      config: { serverUrl: "" },
      apiKey: "sk-test",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("provider-failed")
    }
    expect(calls).toHaveLength(0)
  })
})

// ── Unsupported providers ─────────────────────────────────────────────────────

describe.each([
  "anthropic",
  "google",
  "vertex",
  "bedrock",
  "azure",
] as SdkProvider[])("createModelLister – %s (unsupported)", (sdkProvider) => {
  it(`returns unsupported-model-discovery err for ${sdkProvider}`, async () => {
    const lister = createModelLister({
      httpGet: fakeHttpGet(ok({})),
    })

    const result = await lister({
      sdkProvider,
      config: {},
      apiKey: "key",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported-model-discovery")
    }
  })
})

// ── Descriptor-driven new cases ───────────────────────────────────────────────

it("lists ollama CLOUD models from {base}/tags with the Authorization header", async () => {
  const calls: { url: string; headers: Record<string, string> | undefined }[] =
    []
  const httpGet = async (url: string, headers?: Record<string, string>) => {
    calls.push({ url, headers })
    return { ok: true as const, value: { models: [{ name: "gpt-oss:120b" }] } }
  }
  const lister = createModelLister({ httpGet })
  const r = await lister({ sdkProvider: "ollama", config: {}, apiKey: "k1" })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.value).toEqual([{ id: "gpt-oss:120b" }])
  expect(calls[0]?.url).toBe("https://ollama.com/api/tags")
  expect(calls[0]?.headers).toEqual({ Authorization: "Bearer k1" })
})

it("lists custom models from {serverUrl}/models with a bearer header when keyed", async () => {
  const calls: { url: string; headers: Record<string, string> | undefined }[] =
    []
  const httpGet = async (url: string, headers?: Record<string, string>) => {
    calls.push({ url, headers })
    return { ok: true as const, value: { data: [{ id: "model-a" }] } }
  }
  const lister = createModelLister({ httpGet })
  const r = await lister({
    sdkProvider: "custom",
    config: { serverUrl: "http://localhost:11434/v1" },
    apiKey: "sk",
  })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.value).toEqual([{ id: "model-a" }])
  expect(calls[0]?.url).toBe("http://localhost:11434/v1/models")
  expect(calls[0]?.headers).toEqual({ Authorization: "Bearer sk" })
})

it("lists openrouter models from its fixed base /models (public)", async () => {
  const calls: { url: string }[] = []
  const httpGet = async (url: string) => {
    calls.push({ url })
    return { ok: true as const, value: { data: [{ id: "openai/gpt-4o" }] } }
  }
  const lister = createModelLister({ httpGet })
  const r = await lister({ sdkProvider: "openrouter", config: {} })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.value).toEqual([{ id: "openai/gpt-4o" }])
  expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models")
})

it("returns provider-failed for custom with no server url configured", async () => {
  const httpGet = async () => ({ ok: true as const, value: {} })
  const lister = createModelLister({ httpGet })
  const r = await lister({ sdkProvider: "custom", config: {} })
  expect(r.ok).toBe(false)
})

it("carries openrouter modality metadata into the discovered entries", async () => {
  const httpGet = fakeHttpGet(
    ok({
      data: [
        {
          id: "openai/gpt-4o",
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "deepseek/deepseek-r1",
          architecture: { input_modalities: ["text"] },
        },
      ],
    }),
  )
  const lister = createModelLister({ httpGet })
  const r = await lister({
    sdkProvider: "openrouter" as SdkProvider,
    config: {},
    apiKey: "k",
  })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.value).toEqual([
      { id: "deepseek/deepseek-r1", attachments: { image: false, pdf: false } },
      { id: "openai/gpt-4o", attachments: { image: true, pdf: false } },
    ])
  }
})

it("carries ollama vision families into the discovered entries", async () => {
  const httpGet = fakeHttpGet(
    ok({
      models: [
        { name: "llava:13b", details: { families: ["llama", "clip"] } },
        { name: "llama3:8b", details: { families: ["llama"] } },
      ],
    }),
  )
  const lister = createModelLister({ httpGet })
  const r = await lister({
    sdkProvider: "ollama" as SdkProvider,
    config: {},
    apiKey: "k",
  })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.value).toEqual([
      { id: "llama3:8b", attachments: { image: false, pdf: false } },
      { id: "llava:13b", attachments: { image: true, pdf: false } },
    ])
  }
})

it("omits attachments when the provider payload has no modality metadata", async () => {
  const httpGet = fakeHttpGet(ok({ data: [{ id: "gpt-4o" }] }))
  const lister = createModelLister({ httpGet })
  const r = await lister({
    sdkProvider: "openai" as SdkProvider,
    config: {},
    apiKey: "k",
  })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.value).toEqual([{ id: "gpt-4o" }])
})
