import type { SdkProvider } from "@spectrum/types"
import { SdkProviderSchema } from "@spectrum/types"
import { type ZodTypeAny, z } from "zod"
import type { ReasoningSupport } from "./reasoning-types"

/** A non-secret, declarative form field for a provider's config. */
export const ConfigFieldSpecSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["url", "text", "headers"]),
    required: z.boolean(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
    /** When set, the field's value is injected as this HTTP header (e.g. "HTTP-Referer"). */
    mapsToHeader: z.string().optional(),
  })
  .strict()
export type ConfigFieldSpec = z.infer<typeof ConfigFieldSpecSchema>

/** A secret field name + presentational metadata. The value never lives here. */
export const SecretFieldSpecSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean(),
  })
  .strict()
export type SecretFieldSpec = z.infer<typeof SecretFieldSpecSchema>

/**
 * The presentational projection of a descriptor sent over IPC to the GUI:
 * field specs only — no zod config schema, no SDK mapping, no discovery spec.
 */
export const ProviderCatalogEntrySchema = z
  .object({
    key: SdkProviderSchema,
    label: z.string().min(1),
    configFields: z.array(ConfigFieldSpecSchema),
    secretFields: z.array(SecretFieldSpecSchema),
    supportsCustomHeaders: z.boolean(),
  })
  .strict()
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>

/** How a provider's `apiKey` secret reaches the SDK. */
export type ApiKeyMapping =
  | { readonly kind: "option"; readonly name: string }
  | {
      readonly kind: "header"
      readonly name: string
      readonly scheme: "Bearer"
    }
  | { readonly kind: "none" }

/** How to list models for a provider. */
export type DiscoverySpec =
  | { readonly strategy: "openai-models"; readonly defaultBaseUrl?: string }
  | {
      readonly strategy: "ollama-tags"
      readonly sendAuthHeader: boolean
      readonly defaultBaseUrl?: string
    }
  | { readonly strategy: "none" }

/** How non-secret config + secrets map onto the SDK factory's `create()` options. */
export type SdkMapping = {
  /** The SDK's base-URL option name — canonically "baseURL". */
  readonly baseUrlOption: string
  /** Applied when `config.serverUrl` is absent (e.g. cloud hosts). */
  readonly defaultBaseUrl?: string
  /** How the `apiKey` secret is delivered. */
  readonly apiKey: ApiKeyMapping
  /**
   * Placeholder key used (for `apiKey.kind === "option"`) when no `apiKey` secret is set,
   * so SDKs that require a non-empty key don't throw against keyless local servers. Only
   * set where a missing key is legitimate (e.g. Custom → local Ollama/LM Studio).
   */
  readonly placeholderApiKey?: string
  /** Static headers always sent (rare; most attribution headers come from config fields). */
  readonly defaultHeaders?: Readonly<Record<string, string>>
}

/** The full, runtime descriptor for one provider. Internal to backend packages. */
export type ProviderDescriptor = {
  readonly key: SdkProvider
  readonly label: string
  readonly configFields: readonly ConfigFieldSpec[]
  readonly secretFields: readonly SecretFieldSpec[]
  readonly supportsCustomHeaders: boolean
  /**
   * How the provider delivers a stream. "incremental" providers stream tokens as
   * generated (cloud APIs). "buffered" providers (e.g. Ollama Cloud) compute the
   * whole response server-side and flush it at once after a long quiet period —
   * the stream watchdog must be far more generous for these or it false-fires.
   */
  readonly streaming: "incremental" | "buffered"
  readonly configSchema: ZodTypeAny
  readonly sdkMapping: SdkMapping
  readonly discovery: DiscoverySpec
  /** Default reasoning capability for the provider (refined per-model by resolveReasoning). */
  readonly reasoning: ReasoningSupport
}

/** Error returned by `validateProviderConfig`. A structural subset of proxy's `ProxyError`. */
export type ProviderConfigError =
  | { readonly kind: "unsupported-provider"; readonly sdkProvider: string }
  | { readonly kind: "bad-request"; readonly detail: string }
