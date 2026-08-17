import { describe, expect, it } from "bun:test"
import { type Config, defaultConfig } from "@spectrum/config"
import type { ExtensionManifest } from "@spectrum/extensions"
import type { PluginId } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import { pluginCommand } from "./plugin-command"
import { createMemoryWriter } from "./writer"

/** A well-formed installed extension manifest fixture: one provider contribution with a
 * launch block (so install disclosure has something to print) and a `flow` action (so the
 * GUI-only-action line has something to trigger on). */
const acmeManifest: ExtensionManifest = {
  apiVersion: "spectrum.dev/v1",
  id: "acme" as PluginId,
  name: "Acme",
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: "acme" as PluginId,
        descriptor: {
          label: "Acme",
          configFields: [],
          secretFields: [{ name: "apiKey", label: "API key", required: true }],
          supportsCustomHeaders: false,
          streaming: "incremental",
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "none" },
          actions: [
            {
              kind: "flow",
              id: "signin",
              label: "Sign in",
              context: "provider",
            },
          ],
        },
        transport: {
          kind: "http",
          wire: "openai",
          launch: {
            command: "acme-server",
            args: ["--api-key", "{{apiKey}}", "--port", "{{port}}"],
            envTemplate: { SPECTRUM_TOKEN: "{{hostToken}}" },
            healthPath: "/models",
            readyTimeoutMs: 10_000,
          },
        },
      },
    ],
  },
}

const acmeInstall = {
  id: "acme" as PluginId,
  source: { kind: "path" as const, path: "/home/me/acme", linked: true },
  enabled: true,
}

const harness = (opts?: { removeRefused?: boolean }) => {
  const writer = createMemoryWriter()
  const calls: { op: string; arg: unknown }[] = []
  const deps = {
    out: writer,
    extensions: {
      install: async (input: unknown) => {
        calls.push({ op: "install", arg: input })
        return ok({
          manifest: acmeManifest,
          install: acmeInstall,
          ignoredContributions: [],
        })
      },
      update: async (id: unknown) => {
        calls.push({ op: "update", arg: id })
        return ok({
          manifest: acmeManifest,
          install: acmeInstall,
          ignoredContributions: [],
        })
      },
      remove: async (id: unknown) => {
        calls.push({ op: "remove", arg: id })
        return opts?.removeRefused === true
          ? err({ kind: "in-use", id: "acme", providerIds: ["prv_1"] })
          : ok(undefined)
      },
      setEnabled: async (id: unknown, enabled: boolean) => {
        calls.push({ op: "setEnabled", arg: { id: String(id), enabled } })
        return ok(undefined)
      },
    },
    extensionRegistry: {
      list: async () =>
        ok([{ manifest: acmeManifest, ignoredContributions: [], dir: "/d" }]),
      providerDescriptors: async () => ok([]),
    },
    config: {
      load: async (): Promise<Result<Config, unknown>> =>
        ok({ ...defaultConfig(), providerPlugins: [acmeInstall] }),
      save: async () => ok(undefined),
    },
  }
  const run = (rest: readonly string[], flags = {}) =>
    pluginCommand(deps as never, rest, flags)
  return { run, writer, calls }
}

describe("pluginCommand", () => {
  it("lists installed extensions with their enabled state when given list", async () => {
    const { run, writer } = harness()
    const r = await run(["list"])
    expect(r.ok).toBe(true)
    expect(writer.lines.join("\n")).toContain("acme")
    expect(writer.lines.join("\n")).toMatch(/enabled/i)
  })

  it("installs from a git url when given install", async () => {
    const { run, calls } = harness()
    const r = await run(["install", "https://example.com/acme.git"])
    expect(r.ok).toBe(true)
    expect(calls[0]).toMatchObject({
      op: "install",
      arg: { source: "https://example.com/acme.git" },
    })
  })

  it("installs from an absolute path in link mode by default", async () => {
    const { run, calls } = harness()
    await run(["install", "/home/me/acme"])
    expect(calls[0]?.arg).toMatchObject({ source: "/home/me/acme" })
    expect((calls[0]?.arg as { mode?: string }).mode).toBeUndefined()
  })

  it("passes copy mode through when given --copy", async () => {
    const { run, calls } = harness()
    await run(["install", "/home/me/acme"], { copy: true })
    expect(calls[0]?.arg).toMatchObject({ mode: "copy" })
  })

  it("passes the ref through when given --ref", async () => {
    const { run, calls } = harness()
    await run(["install", "https://example.com/acme.git"], { ref: "v2" })
    expect(calls[0]?.arg).toMatchObject({ ref: "v2" })
  })

  it("discloses the spawned command and declared secrets after installing", async () => {
    const { run, writer } = harness()
    await run(["install", "/home/me/acme"])
    const out = writer.lines.join("\n")
    expect(out).toContain("acme-server")
    expect(out).toContain("apiKey")
  })

  it("never prints a rendered env value or a host token", async () => {
    const { run, writer } = harness()
    await run(["install", "/home/me/acme"])
    const out = writer.lines.join("\n")
    expect(out).not.toContain("SPECTRUM_TOKEN=")
    expect(out).toContain("{{port}}")
  })

  it("writes enabled false to config when given disable", async () => {
    const { run, calls } = harness()
    const r = await run(["disable", "acme"])
    expect(r.ok).toBe(true)
    expect(calls[0]).toMatchObject({
      op: "setEnabled",
      arg: { id: "acme", enabled: false },
    })
  })

  it("writes enabled true to config when given enable", async () => {
    const { run, calls } = harness()
    await run(["enable", "acme"])
    expect(calls[0]).toMatchObject({
      op: "setEnabled",
      arg: { id: "acme", enabled: true },
    })
  })

  it("reports the referencing providers when remove is refused", async () => {
    const { run, writer } = harness({ removeRefused: true })
    const r = await run(["remove", "acme"])
    expect(r.ok).toBe(false)
    expect(writer.lines.join("\n")).toContain("prv_1")
  })

  it("rejects an id that is not a plugin slug before calling the admin", async () => {
    const { run, calls } = harness()
    const r = await run(["remove", "../escape"])
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it("fails with a usage error when the subcommand is unknown", async () => {
    const { run } = harness()
    const r = await run(["teleport"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("usage")
  })

  it("fails with a usage error when install is given no source", async () => {
    const { run } = harness()
    const r = await run(["install"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("usage")
  })

  it("says a flow action is gui-only rather than half-supporting it", async () => {
    const { run, writer } = harness()
    await run(["list"])
    // acmeManifest's contribution declares a `flow` action.
    expect(writer.lines.join("\n")).toMatch(/only available in the GUI/i)
  })
})
