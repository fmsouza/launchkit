import { type HarnessDefinition, HarnessIdSchema } from "@spectrum/types"

export const opencode: HarnessDefinition = {
  id: HarnessIdSchema.parse("opencode"),
  name: "opencode",
  command: "opencode",
  apiFormat: "openai",
  // The proxy serves the OpenAI-compatible API under `/v1` (same as codex). The native driver feeds
  // OPENAI_BASE_URL into an `@ai-sdk/openai-compatible` provider, which appends `/chat/completions` — so
  // the base must include `/v1`, else the model call 404s and the turn produces no output.
  envTemplate: {
    OPENAI_BASE_URL: "{{proxyUrl}}/v1",
    OPENAI_API_KEY: "{{proxyKey}}",
    OPENAI_MODEL: "{{model}}",
  },
  builtIn: true,
  // ACP launch: OpenCode exposes ACP natively (listed on agentclientprotocol.com).
  acp: { args: ["acp"], native: true },
} satisfies HarnessDefinition
