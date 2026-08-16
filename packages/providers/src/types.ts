import type { ProviderKey } from "@spectrum/types"
import { ProviderKeySchema } from "@spectrum/types"
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

const actionBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  /** Where the action is offered: creating a provider, managing an existing one, or both. */
  context: z.enum(["create", "provider", "both"]).default("provider"),
}

export const ProviderActionSchema = z.discriminatedUnion("kind", [
  // Renders ProviderForm over configFields — what "Edit provider" does today.
  z
    .object({ kind: z.literal("edit-config"), ...actionBase })
    .strict(),
  // Renders SecretFieldsForm over secretFields — what "Set secret" does today.
  z
    .object({ kind: z.literal("set-secrets"), ...actionBase })
    .strict(),
  // Runs a plugin-driven step flow; `id` is also the flow id. Contributions only —
  // a builtin has no plugin process to serve steps.
  z
    .object({ kind: z.literal("flow"), ...actionBase })
    .strict(),
])
export type ProviderAction = z.infer<typeof ProviderActionSchema>

/**
 * The presentational projection of a descriptor sent over IPC to the GUI:
 * field specs only — no zod config schema, no SDK mapping, no discovery spec.
 */
export const ProviderCatalogEntrySchema = z
  .object({
    key: ProviderKeySchema,
    label: z.string().min(1),
    configFields: z.array(ConfigFieldSpecSchema),
    secretFields: z.array(SecretFieldSpecSchema),
    supportsCustomHeaders: z.boolean(),
    actions: z.array(ProviderActionSchema),
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

/**
 * The zod counterpart to `DiscoverySpec`, for validating plugin-contributed descriptors.
 * `DiscoverySpec` stays the hand-written, authoritative type — see the pin below.
 */
export const DiscoverySchema = z.discriminatedUnion("strategy", [
  z
    .object({
      strategy: z.literal("openai-models"),
      defaultBaseUrl: z.string().optional(),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("ollama-tags"),
      sendAuthHeader: z.boolean(),
      defaultBaseUrl: z.string().optional(),
    })
    .strict(),
  z.object({ strategy: z.literal("none") }).strict(),
])

/**
 * Pin-only helper: zod's `.optional()` infers `T | undefined` on the property, which
 * under this repo's `exactOptionalPropertyTypes` does not assign into a hand-written
 * `foo?: T` (no explicit `undefined`). Strip the explicit `undefined` so the pin below
 * checks real shape compatibility instead of tripping on that artifact. Not exported —
 * this is not part of the package's API.
 */
type StripUndefined<T> = T extends unknown
  ? { [K in keyof T]: Exclude<T[K], undefined> }
  : never

// Compile-time pin: keep DiscoverySchema's inferred shape assignable to DiscoverySpec.
// If the schema and the hand-written type drift, this line fails `bun run typecheck`.
const _discoverySchemaMatchesType: DiscoverySpec = {} as StripUndefined<
  z.infer<typeof DiscoverySchema>
>

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
  /**
   * Which AI SDK factory serves this provider, for descriptors whose key is not a
   * builtin. Builtins select their factory from `descriptor.key`; a plugin descriptor
   * has no builtin key, so it names the wire format its server speaks and `loadSdk`
   * maps that to `createOpenAI` / `createAnthropic`.
   */
  readonly wire?: "openai" | "anthropic"
}

/** The full, runtime descriptor for one provider. Internal to backend packages. */
export type ProviderDescriptor = {
  readonly key: ProviderKey
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
  /** The setup actions this provider offers (edit config, set secrets, plugin-driven flows). */
  readonly actions: readonly ProviderAction[]
}

/** Error returned by `validateProviderConfig`. A structural subset of proxy's `ProxyError`. */
export type ProviderConfigError =
  | { readonly kind: "unsupported-provider"; readonly sdkProvider: string }
  | { readonly kind: "bad-request"; readonly detail: string }
