import { describe, expect, it } from "bun:test"
import { type Config, defaultConfig } from "@launchkit/config"
import {
  AliasNameSchema,
  type HarnessDefinition,
  HarnessIdSchema,
} from "@launchkit/types"
import { runCli } from "./run"
import { makeFakeDeps } from "./test-support"
import { createMemoryWriter } from "./writer"

const harness: HarnessDefinition = {
  id: HarnessIdSchema.parse("claude"),
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: { ANTHROPIC_BASE_URL: "{{proxyUrl}}" },
  defaultAlias: AliasNameSchema.parse("default"),
}

const configWith = (): Config => ({
  ...defaultConfig(),
  providers: [
    {
      id: "p_openai" as never,
      name: "OpenAI",
      sdkProvider: "openai",
      config: { baseUrl: "https://api.openai.com/v1" },
      secrets: { apiKey: { ref: "kc_openai" } },
      models: ["gpt-4o"],
    },
  ],
  aliases: [
    {
      alias: "fast" as never,
      providerId: "p_openai" as never,
      providerModel: "gpt-4o-mini",
    },
  ],
})

describe("list", () => {
  it("prints each harness id when 'list harnesses' is run", async () => {
    const out = createMemoryWriter()
    const result = await runCli(makeFakeDeps({ out, harnesses: [harness] }))([
      "list",
      "harnesses",
    ])
    expect(result).toEqual({ ok: true, value: undefined })
    expect(out.lines.join("\n")).toContain("claude")
    expect(out.lines.join("\n")).toContain("Claude Code")
  })

  it("prints each provider id and name when 'list providers' is run", async () => {
    const out = createMemoryWriter()
    const result = await runCli(
      makeFakeDeps({ out, initialConfig: configWith() }),
    )(["list", "providers"])
    expect(result).toEqual({ ok: true, value: undefined })
    const text = out.lines.join("\n")
    expect(text).toContain("p_openai")
    expect(text).toContain("OpenAI")
  })

  it("never prints a secret ref or value when 'list providers' is run", async () => {
    const out = createMemoryWriter()
    await runCli(makeFakeDeps({ out, initialConfig: configWith() }))([
      "list",
      "providers",
    ])
    const text = out.lines.join("\n")
    expect(text).not.toContain("kc_openai")
    expect(text).not.toContain("apiKey")
  })

  it("prints each alias mapping when 'list aliases' is run", async () => {
    const out = createMemoryWriter()
    const result = await runCli(
      makeFakeDeps({ out, initialConfig: configWith() }),
    )(["list", "aliases"])
    expect(result).toEqual({ ok: true, value: undefined })
    const text = out.lines.join("\n")
    expect(text).toContain("fast")
    expect(text).toContain("gpt-4o-mini")
  })

  it("returns a usage error when the list subcommand is missing", async () => {
    const result = await runCli(makeFakeDeps())(["list"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("returns a usage error when the list subcommand is unknown", async () => {
    const result = await runCli(makeFakeDeps())(["list", "nonsense"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("usage")
  })

  it("returns a failed error when the registry fails to list harnesses", async () => {
    const result = await runCli(
      makeFakeDeps({
        registryError: { kind: "read-failed", detail: "EACCES" },
      }),
    )(["list", "harnesses"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })

  it("returns a failed error when the config cannot be loaded for providers", async () => {
    const deps = makeFakeDeps()
    const broken = {
      ...deps,
      config: {
        load: async () => ({
          ok: false as const,
          error: { kind: "parse-failed" as const, detail: "bad json" },
        }),
        save: deps.config.save,
      },
    }
    const result = await runCli(broken)(["list", "providers"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("failed")
  })
})
