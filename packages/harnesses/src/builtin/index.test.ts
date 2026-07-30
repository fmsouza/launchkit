import { describe, expect, it } from "bun:test"
import { HarnessDefinitionSchema, HarnessIdSchema } from "@spectrum/types"
import { ALLOWED_TOKENS } from "../tokens"
import {
  builtinHarnesses,
  claude,
  codex,
  gemini,
  openclaw,
  opencode,
} from "./index"

const tokensIn = (s: string): readonly string[] =>
  [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "")

describe("builtinHarnesses", () => {
  it("lists every built-in in a stable order when imported", () => {
    expect(builtinHarnesses.map((h) => h.id)).toEqual([
      HarnessIdSchema.parse("claude"),
      HarnessIdSchema.parse("codex"),
      HarnessIdSchema.parse("opencode"),
      HarnessIdSchema.parse("openclaw"),
      HarnessIdSchema.parse("gemini"),
    ])
  })

  it("marks every built-in as builtIn:true", () => {
    expect(builtinHarnesses.every((h) => h.builtIn === true)).toBe(true)
  })

  it("parses every built-in through HarnessDefinitionSchema", () => {
    for (const h of builtinHarnesses) {
      expect(HarnessDefinitionSchema.safeParse(h).success).toBe(true)
    }
  })

  it("uses only the allowed tokens in every env + args template value", () => {
    for (const h of builtinHarnesses) {
      const values = [
        ...Object.values(h.envTemplate),
        ...(h.argsTemplate ?? []),
      ]
      for (const value of values) {
        for (const token of tokensIn(value)) {
          expect(ALLOWED_TOKENS).toContain(
            token as (typeof ALLOWED_TOKENS)[number],
          )
        }
      }
    }
  })

  it("wires claude to the Anthropic env vars with proxy tokens", () => {
    expect(claude.apiFormat).toBe("anthropic")
    expect(claude.command).toBe("claude")
    expect(claude.envTemplate).toEqual({
      ANTHROPIC_BASE_URL: "{{proxyUrl}}",
      ANTHROPIC_AUTH_TOKEN: "{{proxyKey}}",
      // Claude Code prefers its cached OAuth token over ANTHROPIC_AUTH_TOKEN; an explicit
      // Authorization header overrides it. See the harness definition.
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer {{proxyKey}}",
      ANTHROPIC_MODEL: "{{model}}",
      ANTHROPIC_SMALL_FAST_MODEL: "{{model}}",
      CLAUDE_CODE_MAX_RETRIES: "2",
    })
  })

  it("caps claude's API retries so a failing local proxy errors out in seconds, not minutes", () => {
    const retries = Number(claude.envTemplate.CLAUDE_CODE_MAX_RETRIES)
    expect(Number.isInteger(retries)).toBe(true)
    expect(retries).toBeGreaterThanOrEqual(1)
    expect(retries).toBeLessThanOrEqual(3)
  })

  it("wires opencode to the OpenAI env vars with proxy tokens", () => {
    expect(opencode.apiFormat).toBe("openai")
    expect(opencode.envTemplate).toEqual({
      // `/v1`: the native driver feeds this into an openai-compatible provider that appends
      // `/chat/completions`, so the base must point at the proxy's OpenAI API root.
      OPENAI_BASE_URL: "{{proxyUrl}}/v1",
      OPENAI_API_KEY: "{{proxyKey}}",
      OPENAI_MODEL: "{{model}}",
    })
  })

  it("wires codex to route through the proxy via -c provider args (Responses API) + the proxy key", () => {
    expect(codex.apiFormat).toBe("openai")
    // codex ignores OPENAI_BASE_URL, so the NATIVE path gets a `-c` provider override; the key is
    // env. (ACP mode cannot pass args, so it routes via MODEL_PROVIDER/CODEX_CONFIG — asserted
    // separately below. Both are inert on the path that does not read them.)
    expect(codex.envTemplate.OPENAI_API_KEY).toBe("{{proxyKey}}")
    expect(codex.envTemplate.OPENAI_BASE_URL).toBeUndefined()
    const args = (codex.argsTemplate ?? []).join(" ")
    expect(args).toContain("model_provider=spectrum")
    expect(args).toContain('base_url="{{proxyUrl}}/v1"')
    expect(args).toContain('wire_api="responses"')
    expect(args).toContain("{{model}}")
  })
})

describe("openclaw (gateway, re-architected)", () => {
  it("does NOT render ANTHROPIC_BASE_URL (OpenClaw ignores it; it reads ~/.openclaw/openclaw.json)", () => {
    expect(openclaw.envTemplate.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it("carries no proxy env at all (the driver connects to the gateway directly, not via the proxy)", () => {
    const values = Object.values(openclaw.envTemplate)
    for (const v of values) {
      expect(v).not.toContain("{{proxyUrl}}")
      expect(v).not.toContain("{{proxyKey}}")
    }
  })

  it("still parses through HarnessDefinitionSchema and stays builtIn", () => {
    expect(HarnessDefinitionSchema.safeParse(openclaw).success).toBe(true)
    expect(openclaw.builtIn).toBe(true)
  })
})

describe("builtin ACP configs", () => {
  it("claude reaches ACP through the claude-agent-acp adapter binary", () => {
    expect(claude.acp?.native).toBe(false)
    expect(claude.acp?.command).toBe("claude-agent-acp")
  })

  it("codex renders the ACP-mode proxy routing env", () => {
    // In ACP mode `argsTemplate` (the `-c model_providers.spectrum.*` overrides that are codex's
    // ONLY proxy-routing mechanism) is not passed. The codex-acp adapter reads CODEX_CONFIG +
    // MODEL_PROVIDER instead, so the same routing has to ride in the env or Codex silently falls
    // back to the user's own ChatGPT login. Verified live against codex-acp.
    expect(codex.envTemplate.MODEL_PROVIDER).toBe("spectrum")
    expect(codex.envTemplate.CODEX_CONFIG).toContain("{{proxyUrl}}/v1")
    // Deliberately NOT pinned to a Spectrum route id: Codex prints a "model metadata not found"
    // warning into the conversation for one. The session key carries the route instead.
    expect(codex.envTemplate.CODEX_CONFIG).not.toContain("{{model}}")
    expect(codex.envTemplate.OPENAI_API_KEY).toBe("{{proxyKey}}")
  })

  it("codex's ACP config env parses as JSON once rendered", () => {
    const rendered = (codex.envTemplate.CODEX_CONFIG ?? "").replaceAll(
      "{{proxyUrl}}",
      "http://127.0.0.1:4000",
    )
    expect(() => JSON.parse(rendered) as unknown).not.toThrow()
  })

  it("codex reaches ACP through the codex-acp shim binary", () => {
    expect(codex.acp?.native).toBe(false)
    expect(codex.acp?.command).toBe("codex-acp")
  })

  it("opencode reaches ACP through its own acp subcommand", () => {
    expect(opencode.acp?.native).toBe(true)
    expect(opencode.acp?.command).toBeUndefined()
    expect(opencode.acp?.args).toEqual(["acp"])
  })

  it("claude sends the proxy key as an explicit Authorization header", () => {
    // Claude Code prefers its cached subscription OAuth token over ANTHROPIC_AUTH_TOKEN, so a
    // proxied session 401s. An explicit Authorization custom header OVERRIDES the OAuth one —
    // the same mechanism the ACP adapter itself uses for custom gateways. Verified live against a
    // header-logging endpoint: with it, Claude Code sends Spectrum's token; without it, an
    // sk-ant-oat OAuth token.
    expect(claude.envTemplate.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "Authorization: Bearer {{proxyKey}}",
    )
    expect(claude.envTemplate.ANTHROPIC_AUTH_TOKEN).toBe("{{proxyKey}}")
  })

  it("ships gemini as a builtin ACP harness", () => {
    expect(builtinHarnesses.map((h) => String(h.id))).toContain("gemini")
    expect(gemini.acp?.native).toBe(true)
    expect(gemini.acp?.args).toEqual(["--acp"])
  })

  it("openclaw renders no retired gateway env", () => {
    // OPENCLAW_GATEWAY_URL / _AGENT_ID were read by the deleted bespoke gateway driver. In ACP
    // mode they are inert noise, and they crowded out any real env the harness might need.
    expect(openclaw.envTemplate.OPENCLAW_GATEWAY_URL).toBeUndefined()
    expect(openclaw.envTemplate.OPENCLAW_AGENT_ID).toBeUndefined()
  })

  it("openclaw's description does not advertise the retired native driver", () => {
    expect(openclaw.description ?? "").not.toContain("native driver")
    expect(openclaw.description ?? "").not.toContain("UNVERIFIED")
  })

  it("openclaw reaches ACP through its own acp subcommand", () => {
    expect(openclaw.acp?.native).toBe(true)
    expect(openclaw.acp?.command).toBeUndefined()
    expect(openclaw.acp?.args).toEqual(["acp"])
  })

  it("every builtin declares an acp config", () => {
    for (const h of builtinHarnesses) {
      expect(h.acp).toBeDefined()
      expect(Array.isArray(h.acp?.args)).toBe(true)
      expect(typeof h.acp?.native).toBe("boolean")
    }
  })

  it("every non-native builtin names the shim binary that speaks ACP", () => {
    // A non-native harness reaches ACP through a SEPARATE binary; without a command override the
    // launch would spawn the harness CLI itself, which has no ACP mode.
    for (const h of builtinHarnesses) {
      if (h.acp?.native === false) expect(h.acp.command).toBeDefined()
    }
  })

  it("opencode declares a native acp config", () => {
    expect(opencode.acp?.native).toBe(true)
  })

  it("openclaw declares a native acp config", () => {
    expect(openclaw.acp?.native).toBe(true)
  })
})
