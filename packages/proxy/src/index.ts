export { encodeSessionProxyKey, decodeSessionToken } from "./session-token"
export { checkAuth } from "./auth"
export type { AuthPrincipal } from "./auth"
export { startProxy, isProxyRunning } from "./server"
export type { StartProxyOptions, RunningProxy } from "./server"
export { createHandler } from "./handler"
export type { HandlerDeps } from "./handler"
export { createRouter } from "./router"
export type { Router } from "./router"
export { createProviderFactory } from "./providers/factory"
export type {
  ProviderFactory,
  ModelHandle,
  SdkModule,
  LoadSdk,
} from "./providers/factory"
export { loadSdk } from "./providers/load-sdk"
export { resolveTimeouts } from "./providers/resolve-timeouts"
export { createRealGateway } from "./providers/real-gateway"
export { createScriptedGateway } from "./gateway"
export type { LanguageModelGateway } from "./gateway"
export { parseAnthropicRequest } from "./adapters/anthropic-request"
export { parseOpenAIRequest } from "./adapters/openai-request"
export { parseResponsesRequest } from "./adapters/responses-request"
export { serializeAnthropicStream } from "./adapters/anthropic-stream"
export { serializeOpenAIStream } from "./adapters/openai-stream"
export { serializeResponsesStream } from "./adapters/responses-stream"
export { validateProviderConfig } from "@spectrum/providers"
export {
  createProviderTester,
  createDraftProviderTester,
} from "./provider-tester"
export type {
  ProviderTester,
  ProviderTestResult,
  DraftProviderTester,
  DraftProbeInput,
} from "./provider-tester"
export { createModelLister, createFetchHttpGet } from "./model-lister"
export type { ModelLister, ModelListerInput, HttpGet } from "./model-lister"
export {
  createNameGenerator,
  NAME_GEN_TIMEOUT_MS,
  NAME_MAX_CHARS,
  NAME_GEN_MAX_TOKENS,
} from "./name-generator"
export type {
  NameGenerator,
  NameGeneratorDeps,
  NameGenError,
} from "./name-generator"
export { buildNamePrompt, NAME_PROMPT_MAX } from "./session-name-prompt"
export {
  createInMemoryRuntimeState,
  createFileRuntimeState,
} from "./runtime-state"
export type { RuntimeState } from "./runtime-state"
export type {
  NormalizedRequest,
  NormalizedMessage,
  StreamEvent,
  ProxyError,
} from "./types"
export { NormalizedRequestSchema, NormalizedMessageSchema } from "./types"
