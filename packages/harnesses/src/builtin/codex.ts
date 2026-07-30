import { type HarnessDefinition, HarnessIdSchema } from "@spectrum/types"

export const codex: HarnessDefinition = {
  id: HarnessIdSchema.parse("codex"),
  name: "Codex",
  command: "codex",
  apiFormat: "openai",
  // codex (0.130+) only routes through a provider defined in its config.toml — env vars like
  // OPENAI_BASE_URL are ignored. So we register a provider via `-c` overrides that points codex at
  // the proxy over the OpenAI Responses API (codex dropped wire_api="chat"), and pass the per-run
  // key via OPENAI_API_KEY (codex sends it as Bearer; no ChatGPT-login override was observed).
  envTemplate: {
    OPENAI_API_KEY: "{{proxyKey}}",
  },
  argsTemplate: [
    "-c",
    "model_provider=spectrum",
    "-c",
    'model_providers.spectrum.name="Spectrum"',
    "-c",
    'model_providers.spectrum.base_url="{{proxyUrl}}/v1"',
    "-c",
    'model_providers.spectrum.env_key="OPENAI_API_KEY"',
    "-c",
    'model_providers.spectrum.wire_api="responses"',
    "-m",
    "{{model}}",
  ],
  builtIn: true,
  // ACP launch: Codex exposes ACP via Zed's codex-acp adapter (non-native shim).
  // The exact launch flag is verified per ticket #121 against the live adapter.
  acp: { args: ["acp"], native: false },
} satisfies HarnessDefinition
