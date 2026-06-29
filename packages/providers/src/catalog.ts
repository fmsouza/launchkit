import type { SdkProvider } from "@spectrum/types"
import { z } from "zod"
import { ALL_TIERS, type ReasoningSupport } from "./reasoning-types"
import type {
  ProviderCatalogEntry,
  ProviderDescriptor,
  SecretFieldSpec,
} from "./types"

const API_KEY_OPTIONAL: SecretFieldSpec = {
  name: "apiKey",
  label: "API key",
  required: false,
}
const API_KEY_REQUIRED: SecretFieldSpec = {
  name: "apiKey",
  label: "API key",
  required: true,
}

/** Reusable empty/strict config schema for providers whose SDK needs no extra config. */
const emptyConfig = z.object({}).strict()

const NO_REASONING: ReasoningSupport = { shape: "none", supportedTiers: [] }
const OPENAI_EFFORT: ReasoningSupport = {
  shape: "openai-effort",
  // OpenAI reasoning models expose minimal|low|medium|high (no xhigh/max).
  supportedTiers: ["off", "minimal", "low", "medium", "high"],
}
const ANTHROPIC_THINKING: ReasoningSupport = {
  shape: "anthropic-thinking",
  supportedTiers: ALL_TIERS,
}
const GOOGLE_THINKING: ReasoningSupport = {
  shape: "google-thinking",
  supportedTiers: ALL_TIERS,
}

/** A dedicated AI-SDK provider that takes only an apiKey (option) and lists via /v1/models. */
const openAiCompatible = (
  key: SdkProvider,
  label: string,
  discoveryBaseUrl: string,
  reasoning: ReasoningSupport = NO_REASONING,
): ProviderDescriptor => ({
  key,
  label,
  configFields: [],
  secretFields: [API_KEY_REQUIRED],
  supportsCustomHeaders: false,
  streaming: "incremental",
  configSchema: emptyConfig,
  sdkMapping: {
    baseUrlOption: "baseURL",
    apiKey: { kind: "option", name: "apiKey" },
  },
  discovery: { strategy: "openai-models", defaultBaseUrl: discoveryBaseUrl },
  reasoning,
})

/** A provider whose model list we cannot discover (the UI falls back to free-text). */
const noDiscovery = (
  key: SdkProvider,
  label: string,
  configSchema = emptyConfig,
  configFields: ProviderDescriptor["configFields"] = [],
  reasoning: ReasoningSupport = NO_REASONING,
): ProviderDescriptor => ({
  key,
  label,
  configFields,
  secretFields: [API_KEY_REQUIRED],
  supportsCustomHeaders: false,
  streaming: "incremental",
  configSchema,
  sdkMapping: {
    baseUrlOption: "baseURL",
    apiKey: { kind: "option", name: "apiKey" },
  },
  discovery: { strategy: "none" },
  reasoning,
})

const descriptors: Record<SdkProvider, ProviderDescriptor> = {
  openai: openAiCompatible(
    "openai",
    "OpenAI",
    "https://api.openai.com/v1",
    OPENAI_EFFORT,
  ),
  groq: openAiCompatible("groq", "Groq", "https://api.groq.com/openai/v1"),
  xai: openAiCompatible("xai", "xAI", "https://api.x.ai/v1"),
  fireworks: openAiCompatible(
    "fireworks",
    "Fireworks",
    "https://api.fireworks.ai/inference/v1",
  ),
  perplexity: openAiCompatible(
    "perplexity",
    "Perplexity",
    "https://api.perplexity.ai/v1",
  ),
  cerebras: openAiCompatible(
    "cerebras",
    "Cerebras",
    "https://api.cerebras.ai/v1",
  ),
  mistral: openAiCompatible("mistral", "Mistral", "https://api.mistral.ai/v1"),
  cohere: openAiCompatible(
    "cohere",
    "Cohere",
    "https://api.cohere.ai/compatibility/v1",
  ),

  anthropic: noDiscovery(
    "anthropic",
    "Anthropic",
    emptyConfig,
    [],
    ANTHROPIC_THINKING,
  ),
  google: noDiscovery("google", "Google", emptyConfig, [], GOOGLE_THINKING),
  vertex: noDiscovery(
    "vertex",
    "Google Vertex",
    emptyConfig,
    [],
    GOOGLE_THINKING,
  ),
  bedrock: noDiscovery(
    "bedrock",
    "Amazon Bedrock",
    z.object({ region: z.string().min(1) }).strict(),
    [{ name: "region", label: "AWS region", kind: "text", required: true }],
    ANTHROPIC_THINKING,
  ),
  azure: noDiscovery(
    "azure",
    "Azure OpenAI",
    z
      .object({
        resourceName: z.string().min(1),
        deploymentId: z.string().min(1),
      })
      .strict(),
    [
      {
        name: "resourceName",
        label: "Resource name",
        kind: "text",
        required: true,
      },
      {
        name: "deploymentId",
        label: "Deployment id",
        kind: "text",
        required: true,
      },
    ],
    OPENAI_EFFORT,
  ),

  // ── Custom: generic OpenAI-compatible endpoint ──────────────────────────────
  custom: {
    key: "custom",
    label: "Custom (OpenAI-compatible)",
    configFields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: false,
        placeholder: "http://localhost:11434/v1",
      },
      {
        name: "headers",
        label: "Custom headers",
        kind: "headers",
        required: false,
      },
    ],
    secretFields: [API_KEY_OPTIONAL],
    supportsCustomHeaders: true,
    streaming: "incremental",
    configSchema: z
      .object({
        serverUrl: z.string().url().optional(),
        headers: z
          .string()
          .optional()
          .refine(
            (v) => {
              if (v === undefined || v === "") return true
              try {
                const parsed: unknown = JSON.parse(v)
                if (typeof parsed !== "object" || parsed === null) return false
                return Object.values(parsed).every((x) => typeof x === "string")
              } catch {
                return false
              }
            },
            { message: "headers must be a JSON object of string values" },
          ),
      })
      .strict(),
    sdkMapping: {
      baseUrlOption: "baseURL",
      apiKey: { kind: "option", name: "apiKey" },
      // Local OpenAI-compatible servers (Ollama, LM Studio, …) need no key, but
      // @ai-sdk/openai throws without one — send a harmless placeholder when unset.
      placeholderApiKey: "not-needed",
    },
    discovery: { strategy: "openai-models" },
    reasoning: NO_REASONING,
  },

  // ── Ollama Cloud ────────────────────────────────────────────────────────────
  ollama: {
    key: "ollama",
    label: "Ollama Cloud",
    configFields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: false,
        default: "https://ollama.com/api",
        placeholder: "https://ollama.com/api",
      },
    ],
    secretFields: [API_KEY_REQUIRED],
    supportsCustomHeaders: false,
    streaming: "buffered",
    configSchema: z.object({ serverUrl: z.string().url().optional() }).strict(),
    sdkMapping: {
      baseUrlOption: "baseURL",
      defaultBaseUrl: "https://ollama.com/api",
      apiKey: { kind: "header", name: "Authorization", scheme: "Bearer" },
    },
    discovery: {
      strategy: "ollama-tags",
      sendAuthHeader: true,
      defaultBaseUrl: "https://ollama.com/api",
    },
    reasoning: NO_REASONING,
  },

  // ── OpenRouter ──────────────────────────────────────────────────────────────
  openrouter: {
    key: "openrouter",
    label: "OpenRouter",
    configFields: [
      {
        name: "httpReferer",
        label: "App URL (HTTP-Referer)",
        kind: "text",
        required: false,
        mapsToHeader: "HTTP-Referer",
      },
      {
        name: "appTitle",
        label: "App title (X-Title)",
        kind: "text",
        required: false,
        mapsToHeader: "X-Title",
      },
    ],
    secretFields: [API_KEY_REQUIRED],
    supportsCustomHeaders: false,
    streaming: "incremental",
    configSchema: z
      .object({
        httpReferer: z.string().optional(),
        appTitle: z.string().optional(),
      })
      .strict(),
    sdkMapping: {
      baseUrlOption: "baseURL",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      apiKey: { kind: "option", name: "apiKey" },
    },
    discovery: {
      strategy: "openai-models",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
    reasoning: NO_REASONING,
  },
}

/** Look up the descriptor for an SDK provider. Total over the `SdkProvider` union. */
export const getDescriptor = (key: SdkProvider): ProviderDescriptor =>
  descriptors[key]

/** All descriptors (runtime form). */
export const listDescriptors = (): readonly ProviderDescriptor[] =>
  Object.values(descriptors)

/** Project one descriptor to its presentational, IPC-safe entry. */
export const toCatalogEntry = (
  d: ProviderDescriptor,
): ProviderCatalogEntry => ({
  key: d.key,
  label: d.label,
  configFields: [...d.configFields],
  secretFields: [...d.secretFields],
  supportsCustomHeaders: d.supportsCustomHeaders,
})

/** The full presentational catalog for the GUI. */
export const providerCatalog = (): readonly ProviderCatalogEntry[] =>
  listDescriptors().map(toCatalogEntry)
