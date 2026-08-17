import {
  attachmentsFromOllamaTag,
  attachmentsFromOpenAiEntry,
} from "@spectrum/providers"
import type { ProviderDescriptor } from "@spectrum/providers"
import type { DiscoveredModel } from "@spectrum/types"
import { isPluginKey } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { ResolveBaseUrl } from "./providers/resolve-base-url"
import type { ProxyError } from "./types"

// ── HttpGet interface ─────────────────────────────────────────────────────────

/**
 * A minimal injected HTTP GET abstraction: fetches a URL (with optional
 * headers), parses the response as JSON, and returns it as an unknown value.
 * Non-2xx status, network failures, and JSON parse errors map to ProxyError.
 */
export type HttpGet = (
  url: string,
  headers?: Readonly<Record<string, string>>,
) => Promise<Result<unknown, ProxyError>>

/**
 * Real `HttpGet` adapter built on the global `fetch`. Non-2xx responses and
 * JSON parse failures are mapped to `{ kind: "provider-failed", detail }`.
 */
export const createFetchHttpGet = (): HttpGet => async (url, headers) => {
  let res: Response
  try {
    const init: RequestInit = { method: "GET" }
    if (headers !== undefined) init.headers = headers as Record<string, string>
    res = await fetch(url, init)
  } catch (e) {
    return err({
      kind: "provider-failed",
      detail: `network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  if (!res.ok) {
    return err({
      kind: "provider-failed",
      detail: `HTTP ${res.status} from ${url}`,
    })
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    return err({
      kind: "provider-failed",
      detail: `failed to parse JSON from ${url}: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  return ok(body)
}

// ── Response validators ───────────────────────────────────────────────────────

/** Validate and extract ollama /api/tags response → DiscoveredModel[]. */
const parseOllamaTags = (
  body: unknown,
): Result<readonly DiscoveredModel[], ProxyError> => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("models" in body) ||
    !Array.isArray((body as { models: unknown }).models)
  ) {
    return err({
      kind: "provider-failed",
      detail:
        "unexpected response shape from ollama /api/tags: missing .models array",
    })
  }

  const models = (body as { models: unknown[] }).models
  const out: DiscoveredModel[] = []
  for (const item of models) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("name" in item) ||
      typeof (item as { name: unknown }).name !== "string"
    ) {
      return err({
        kind: "provider-failed",
        detail:
          "unexpected item shape in ollama /api/tags .models: missing .name string",
      })
    }
    const name = (item as { name: string }).name
    const caps = attachmentsFromOllamaTag(item)
    out.push(
      caps === undefined ? { id: name } : { id: name, attachments: caps },
    )
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return ok(out)
}

/** Validate and extract OpenAI /v1/models response → DiscoveredModel[]. */
const parseOpenAIModels = (
  body: unknown,
): Result<readonly DiscoveredModel[], ProxyError> => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("data" in body) ||
    !Array.isArray((body as { data: unknown }).data)
  ) {
    return err({
      kind: "provider-failed",
      detail: "unexpected response shape from /v1/models: missing .data array",
    })
  }

  const data = (body as { data: unknown[] }).data
  const out: DiscoveredModel[] = []
  for (const item of data) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof (item as { id: unknown }).id !== "string"
    ) {
      return err({
        kind: "provider-failed",
        detail: "unexpected item shape in /v1/models .data: missing .id string",
      })
    }
    const id = (item as { id: string }).id
    const caps = attachmentsFromOpenAiEntry(item)
    out.push(caps === undefined ? { id } : { id, attachments: caps })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return ok(out)
}

// ── ModelLister ───────────────────────────────────────────────────────────────

/** Input to the model lister. */
export type ModelListerInput = {
  /** The SDK provider identifier (e.g. "openai", "ollama", or a `plugin:`-prefixed key). */
  readonly sdkProvider: string
  /** Non-secret config including optional `serverUrl`. */
  readonly config: Readonly<Record<string, string>>
  /** Resolved secret API key (absent for keyless providers like ollama). */
  readonly apiKey?: string
  /**
   * Every resolved secret, for the supervision seam: a supervised plugin renders these into
   * its child process's environment. Discovery itself only ever uses `apiKey`.
   */
  readonly secrets?: Readonly<Record<string, string>>
  /**
   * The saved provider's instance key, or absent on the draft path. A supervising resolver
   * keys one child process per instance, so it has nothing to key on without it.
   */
  readonly instanceKey?: string
}

/**
 * True when `url`'s host is the local machine. A plugin-contributed provider is local BY
 * DEFINITION, so this is the whole set of hosts discovery may reach for one.
 */
const isLoopbackUrl = (url: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

/**
 * Lists the models available from a configured provider.
 * Returns `Ok<readonly DiscoveredModel[]>` on success or `Err<ProxyError>` when
 * the provider is unsupported, unreachable, or returns an unexpected shape.
 */
export type ModelLister = (
  input: ModelListerInput,
) => Promise<Result<readonly DiscoveredModel[], ProxyError>>

/**
 * Build a `ModelLister` over an injected `HttpGet`. No network calls in tests:
 * pass a fake `HttpGet` that returns canned bodies.
 *
 * PERFORMANCE: provider instances are NOT cached here (they're cached in the
 * factory); discovery is an on-demand call, not a persistent connection.
 * SECURITY: the apiKey is used only for outbound headers, never returned.
 */
export const createModelLister =
  (deps: {
    readonly httpGet: HttpGet
    /** Resolve a provider key to its descriptor. Injected so plugin providers resolve too. */
    readonly getDescriptor: (key: string) => ProviderDescriptor | undefined
    /**
     * The SAME supervision seam the provider factory uses. Discovery must not compute its own
     * base url: a supervised plugin's port is dynamic and known only to the supervisor, and a
     * second, independent rule for where a plugin's traffic goes is a second place to get it
     * wrong.
     */
    readonly resolveBaseUrl: ResolveBaseUrl
  }): ModelLister =>
  async ({ sdkProvider, config, apiKey, secrets, instanceKey }) => {
    const descriptor = deps.getDescriptor(sdkProvider)
    if (descriptor === undefined)
      return err({ kind: "unsupported-provider", sdkProvider })
    const discovery = descriptor.discovery

    if (discovery.strategy === "none") {
      return err({ kind: "unsupported-model-discovery", sdkProvider })
    }

    const resolved = await deps.resolveBaseUrl({
      descriptor,
      config,
      secrets: secrets ?? {},
      instanceKey,
    })
    if (!resolved.ok) return resolved

    const isPlugin = isPluginKey(String(descriptor.key))
    // SECURITY: `discovery.defaultBaseUrl` comes from the plugin's own manifest, and the
    // openai-models branch below attaches `Authorization: Bearer <apiKey>`. Two rules, both
    // applied to EVERY plugin-keyed descriptor — supervised or user-run, no distinction: the
    // base url may only come from the supervision seam or the url the USER configured, and it
    // must be loopback. A user-run plugin server on a LAN host can therefore serve chat but
    // cannot list models here; that is a known gap, not an oversight.
    const configured =
      config.serverUrl !== undefined && config.serverUrl !== ""
        ? config.serverUrl
        : isPlugin
          ? // NOT redundant with the loopback check below: any local process can listen on a
            // port, so a manifest declaring `http://127.0.0.1:9999` would pass that check and
            // still receive the user's key. A plugin never names its own discovery host.
            ""
          : (discovery.defaultBaseUrl ?? "")
    const base = resolved.value ?? configured
    if (base === "") {
      return err({
        kind: "provider-failed",
        detail: `no base URL configured for provider "${sdkProvider}" and no default is known`,
      })
    }
    if (isPlugin && !isLoopbackUrl(base)) {
      return err({
        kind: "bad-request",
        detail: `extension provider "${sdkProvider}" must be reached on loopback`,
      })
    }

    if (discovery.strategy === "ollama-tags") {
      const headers: Record<string, string> = {}
      if (
        discovery.sendAuthHeader &&
        apiKey !== undefined &&
        apiKey.length > 0
      ) {
        headers.Authorization = `Bearer ${apiKey}`
      }
      const response = await deps.httpGet(
        `${base}/tags`,
        Object.keys(headers).length > 0 ? headers : undefined,
      )
      if (!response.ok) return response
      return parseOllamaTags(response.value)
    }

    // strategy === "openai-models"
    const headers: Record<string, string> = {}
    if (apiKey !== undefined && apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`
    }
    const response = await deps.httpGet(
      `${base}/models`,
      Object.keys(headers).length > 0 ? headers : undefined,
    )
    if (!response.ok) return response
    return parseOpenAIModels(response.value)
  }
