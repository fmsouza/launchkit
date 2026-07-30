import { type HarnessDefinition, HarnessIdSchema } from "@spectrum/types"

export const claude: HarnessDefinition = {
  id: HarnessIdSchema.parse("claude"),
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    // Use ANTHROPIC_AUTH_TOKEN (the Bearer auth for a custom gateway), not
    // ANTHROPIC_API_KEY: ANTHROPIC_API_KEY loses to a cached subscription login and caused a 401
    // retry loop. We omit it to avoid the precedence ambiguity / approval prompt.
    ANTHROPIC_AUTH_TOKEN: "{{proxyKey}}",
    // ...and send the key as an EXPLICIT Authorization header too, because
    // ANTHROPIC_AUTH_TOKEN alone is no longer enough: Claude Code (2.1.220) prefers its cached
    // subscription OAuth token, so a proxied session 401s. Captured against a header-logging
    // endpoint — without this header Claude sends `Bearer sk-ant-oat…` (115 chars) plus
    // `anthropic-beta: …oauth-2025-04-20…`; with it, it sends Spectrum's key.
    //
    // This is the same mechanism the ACP adapter uses for custom gateways: it sets
    // ANTHROPIC_BASE_URL + ANTHROPIC_CUSTOM_HEADERS and a placeholder ANTHROPIC_AUTH_TOKEN "to
    // bypass claude login requirement". A custom header WINS over the OAuth one, which
    // `x-api-key` would not (the proxy prefers Authorization when both are present).
    //
    // SECURITY: this carries the per-run proxy key, exactly like ANTHROPIC_AUTH_TOKEN. The
    // rendered env is never logged, and the key is registered for redaction.
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer {{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
    // Claude Code uses a separate small/fast model for background work (topic/title
    // detection, etc.) and routes it through ANTHROPIC_BASE_URL. Without this it would
    // request its default haiku id, which our router does not know (unknown-model).
    // Pin it to the SAME selected route id so every request resolves through the proxy.
    ANTHROPIC_SMALL_FAST_MODEL: "{{model}}",
    // Claude Code's default API retry policy (~10 attempts with growing backoff)
    // is tuned for the real Anthropic API. Against our loopback proxy it turns a
    // hard provider failure (e.g. exhausted rate-limit quota) into minutes of
    // apparent hang. Two retries still covers transient blips.
    CLAUDE_CODE_MAX_RETRIES: "2",
  },
  builtIn: true,
  // ACP launch: Claude Code has NO ACP mode of its own (verified: `claude --help` has no --acp
  // flag). It reaches ACP through the ACP project's adapter, a separate binary from the
  // `@agentclientprotocol/claude-agent-acp` package — install with
  // `npm i -g @agentclientprotocol/claude-agent-acp`. (The older `@zed-industries/claude-code-acp`
  // is deprecated and its `session/new` fails.) The adapter drives Claude Code itself, so the
  // proxy env above still applies.
  acp: { command: "claude-agent-acp", args: [], native: false },
} satisfies HarnessDefinition
