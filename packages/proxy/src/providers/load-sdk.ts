import type { ProviderDescriptor } from "@spectrum/providers"
import { isPluginKey } from "@spectrum/types"
import type { LoadSdk, SdkModule } from "./factory"

/** Lazily import the AI SDK factory a plugin descriptor's wire format maps to. */
const loadByWire = async (
  wire: "openai" | "anthropic" | undefined,
  key: string,
): Promise<SdkModule> => {
  if (wire === "openai")
    return { create: (await import("@ai-sdk/openai")).createOpenAI }
  if (wire === "anthropic")
    return { create: (await import("@ai-sdk/anthropic")).createAnthropic }
  throw new Error(`plugin provider declares no wire format: ${key}`)
}

export const loadSdk: LoadSdk = async (
  descriptor: ProviderDescriptor,
): Promise<SdkModule> => {
  const key = descriptor.key
  if (isPluginKey(key)) return loadByWire(descriptor.sdkMapping.wire, key)
  switch (key) {
    case "openai":
      return { create: (await import("@ai-sdk/openai")).createOpenAI }
    case "anthropic":
      return { create: (await import("@ai-sdk/anthropic")).createAnthropic }
    case "google":
      return {
        create: (await import("@ai-sdk/google")).createGoogleGenerativeAI,
      }
    case "vertex":
      return { create: (await import("@ai-sdk/google-vertex")).createVertex }
    case "bedrock":
      return {
        create: (await import("@ai-sdk/amazon-bedrock")).createAmazonBedrock,
      }
    case "azure":
      return { create: (await import("@ai-sdk/azure")).createAzure }
    case "mistral":
      return { create: (await import("@ai-sdk/mistral")).createMistral }
    case "cohere":
      return { create: (await import("@ai-sdk/cohere")).createCohere }
    case "groq":
      return { create: (await import("@ai-sdk/groq")).createGroq }
    case "xai":
      return { create: (await import("@ai-sdk/xai")).createXai }
    case "fireworks":
      return { create: (await import("@ai-sdk/fireworks")).createFireworks }
    case "perplexity":
      return { create: (await import("@ai-sdk/perplexity")).createPerplexity }
    case "cerebras":
      return { create: (await import("@ai-sdk/cerebras")).createCerebras }
    case "ollama":
      return { create: (await import("ollama-ai-provider-v2")).createOllama }
    case "custom":
      return { create: (await import("@ai-sdk/openai")).createOpenAI }
    case "openrouter":
      return { create: (await import("@ai-sdk/openai")).createOpenAI }
    default:
      throw new Error(`unsupported sdkProvider: ${key}`)
  }
}
