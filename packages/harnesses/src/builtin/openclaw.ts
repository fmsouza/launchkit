import { type HarnessDefinition, HarnessIdSchema } from "@spectrum/types"

/**
 * OpenClaw is a delegating GATEWAY daemon, not a Claude-style CLI: it reads its provider/model
 * config from `~/.openclaw/openclaw.json` (`models.providers`) and does NOT honor
 * `ANTHROPIC_BASE_URL`. There is therefore no proxy env to render — routing OpenClaw through the
 * Spectrum proxy is a user-side config step (point a `models.providers.<id>.baseUrl` at the proxy),
 * deliberately out of scope for the harness definition.
 *
 * Spectrum drives it over ACP (`openclaw acp`, docs.openclaw.ai/cli/acp) like every other harness.
 * The retired bespoke Gateway-WebSocket driver and the `OPENCLAW_GATEWAY_URL`/`OPENCLAW_AGENT_ID`
 * env it read are gone.
 */
export const openclaw: HarnessDefinition = {
  id: HarnessIdSchema.parse("openclaw"),
  name: "OpenClaw",
  command: "openclaw",
  apiFormat: "anthropic",
  description:
    "OpenClaw over ACP. Provider/model routing is configured in ~/.openclaw/openclaw.json — point a provider baseUrl at the Spectrum proxy to route through it.",
  envTemplate: {},
  builtIn: true,
  // ACP launch: OpenClaw exposes ACP natively via `openclaw acp` — no adapter shim needed.
  acp: { args: ["acp"], native: true },
} satisfies HarnessDefinition
