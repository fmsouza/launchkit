export {
  ConfigFieldSpecSchema,
  SecretFieldSpecSchema,
  ProviderCatalogEntrySchema,
} from "./types"
export type {
  ConfigFieldSpec,
  SecretFieldSpec,
  ProviderCatalogEntry,
  ProviderDescriptor,
  ApiKeyMapping,
  DiscoverySpec,
  SdkMapping,
  ProviderConfigError,
} from "./types"
export {
  getDescriptor,
  listDescriptors,
  toCatalogEntry,
  providerCatalog,
} from "./catalog"
export { validateProviderConfig } from "./validate"
export { createProviderRegistry } from "./registry"
export type { ProviderRegistry } from "./registry"
export { configSchemaFromFields } from "./config-schema-from-fields"
export { ALL_TIERS } from "./reasoning-types"
export type { ReasoningShape, ReasoningSupport } from "./reasoning-types"
export { resolveReasoning } from "./resolve-reasoning"
export { clampTier } from "./clamp-tier"
export {
  buildProviderOptions,
  reasoningDisablesTemperature,
} from "./build-provider-options"
export {
  attachmentsFromOllamaTag,
  attachmentsFromOpenAiEntry,
  heuristicAttachments,
} from "./attachment-capabilities"
export type { DiscoveredAttachments } from "./attachment-capabilities"
