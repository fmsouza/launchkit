import {
  type DiscoverySpec,
  type ProviderDescriptor,
  configSchemaFromFields,
} from "@spectrum/providers"
import { pluginKeyOf } from "@spectrum/types"
import type { ProviderContribution } from "./provider-contribution"

/**
 * Project a validated contribution onto the runtime descriptor the provider registry
 * consumes. The config schema is DERIVED from the declared field specs — JSON cannot carry
 * a zod schema. A placeholder api key is always declared: a supervised local server
 * typically needs no key, but `@ai-sdk/openai` throws without a non-empty string.
 */
export const descriptorFromContribution = (
  contribution: ProviderContribution,
): ProviderDescriptor => ({
  key: pluginKeyOf(contribution.id),
  label: contribution.descriptor.label,
  configFields: contribution.descriptor.configFields,
  secretFields: contribution.descriptor.secretFields,
  supportsCustomHeaders: contribution.descriptor.supportsCustomHeaders,
  streaming: contribution.descriptor.streaming,
  configSchema: configSchemaFromFields(contribution.descriptor.configFields),
  sdkMapping: {
    baseUrlOption: "baseURL",
    apiKey: { kind: "option", name: "apiKey" },
    placeholderApiKey: "spectrum-plugin",
    wire: contribution.transport.wire,
  },
  // DiscoverySchema infers optional properties as `T | undefined`; under this repo's
  // exactOptionalPropertyTypes that doesn't structurally match the hand-written
  // DiscoverySpec (`foo?: T`, no explicit undefined) even though the runtime shape is
  // identical — see the same cast rationale at providers/src/types.ts's StripUndefined.
  discovery: contribution.descriptor.discovery as DiscoverySpec,
  reasoning: contribution.descriptor.reasoning,
  actions: contribution.descriptor.actions,
})
