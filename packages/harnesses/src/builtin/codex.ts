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
    // ACP-mode routing. The `-c` overrides below are ARGS, and ACP mode replaces args with the
    // adapter's own — so without these the ACP session silently falls back to the user's ChatGPT
    // login instead of the Spectrum proxy (observed live: "You've hit your usage limit"). The
    // codex-acp adapter reads MODEL_PROVIDER + CODEX_CONFIG (a JSON object merged into the Codex
    // session config) and honors OPENAI_API_KEY. Inert on the native path, which uses the args.
    MODEL_PROVIDER: "spectrum",
    CODEX_CONFIG:
      '{"model":"{{model}}","model_providers":{"spectrum":{"name":"Spectrum","base_url":"{{proxyUrl}}/v1","env_key":"OPENAI_API_KEY","wire_api":"responses"}}}',
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
  // ACP launch: `codex` has NO `acp` subcommand (verified against `codex --help`). It reaches ACP
  // through a separate adapter binary from `@agentclientprotocol/codex-acp` — install with
  // `npm i -g @agentclientprotocol/codex-acp`. (The older `@zed-industries/codex-acp` is
  // deprecated but ships the same `codex-acp` binary.) NOTE: `argsTemplate` above (the `-c`
  // provider overrides that route codex through the proxy) is NOT passed in ACP mode; the shim's
  // provider routing is verified per ticket #121.
  acp: { command: "codex-acp", args: [], native: false },
} satisfies HarnessDefinition
