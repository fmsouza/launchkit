import { describe, expect, it } from "bun:test"
import { type Config, defaultConfig } from "@spectrum/config"
import type { ExtensionManifest, PluginError } from "@spectrum/extensions"
import type { PluginId } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import { pluginCommand } from "./plugin-command"
import { createMemoryWriter } from "./writer"

/**
 * A well-formed installed extension manifest fixture: one provider contribution with a
 * launch block (so install disclosure has something to print) and a `flow` action (so the
 * GUI-only-action line has something to trigger on). The launch templates every kind of
 * value a sabotaged `discloseInstall` could leak: `{{apiKey}}` (a declared SECRET field —
 * the one most worth rendering-into-real-value by mistake) and `{{hostToken}}` (a RUNTIME
 * token the CLI never has a real value for either). `envTemplate` carries the same tokens
 * again so a sabotage that dumps the env map (in ANY form — key=value, JSON, ...) instead
 * of skipping it is also visible to a test that pins the full output.
 */
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
            args: [
              "--api-key",
              "{{apiKey}}",
              "--host-token",
              "{{hostToken}}",
              "--port",
              "{{port}}",
            ],
            envTemplate: {
              API_KEY: "{{apiKey}}",
              SPECTRUM_TOKEN: "{{hostToken}}",
            },
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

const harness = (opts?: {
  removeRefused?: boolean
  listError?: PluginError
  /** Install records the registry does NOT list — a dead linked source, or a clone the
   * user deleted by hand. The GUI reconstructs a row for each; the CLI must too. */
  extraInstalls?: readonly (typeof acmeInstall)[]
}) => {
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
        opts?.listError !== undefined
          ? err(opts.listError)
          : ok([
              { manifest: acmeManifest, ignoredContributions: [], dir: "/d" },
            ]),
      providerDescriptors: async () => ok([]),
    },
    config: {
      load: async (): Promise<Result<Config, unknown>> =>
        ok({
          ...defaultConfig(),
          providerPlugins: [acmeInstall, ...(opts?.extraInstalls ?? [])],
        }),
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

  /** `plugin remove <id>` still works on these, so a user who cannot see one cannot
   * recover it. The handler already reconstructs an `unavailable` row for each. */
  it("lists an install record the registry skipped, tagged unavailable", async () => {
    const { run, writer } = harness({
      extraInstalls: [
        {
          id: "ghost" as PluginId,
          source: { kind: "path" as const, path: "/gone/ghost", linked: true },
          enabled: true,
        },
      ],
    })
    const r = await run(["list"])
    expect(r.ok).toBe(true)
    const out = writer.lines.join("\n")
    expect(out).toContain("ghost")
    expect(out).toMatch(/unavailable/i)
  })

  it("does not tag a listed extension as unavailable", async () => {
    const { run, writer } = harness()
    await run(["list"])
    expect(writer.lines.join("\n")).not.toMatch(/unavailable/i)
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

  it("discloses the origin, spawned command, and declared secret names as exactly these lines", async () => {
    const { run, writer } = harness()
    await run(["install", "/home/me/acme"])
    // Full-array equality, not a substring check: any change to what gets printed —
    // a rendered arg, an extra env-dump line, a reordered/duplicated notice — breaks
    // this test, not just a change to the one property a `.toContain` happens to probe.
    expect(writer.lines).toEqual([
      "installed acme (1.0.0) from linked path /home/me/acme",
      "  will spawn: acme-server --api-key {{apiKey}} --host-token {{hostToken}} --port {{port}}",
      "  declared secrets: apiKey",
      "  acme: at least one setup action is only available in the GUI",
    ])
  })

  it("never renders the declared secret or runtime tokens into the printed args", async () => {
    const { run, writer } = harness()
    await run(["install", "/home/me/acme"])
    const out = writer.lines.join("\n")
    // The manifest's OWN unrendered templates must appear verbatim — `discloseInstall`
    // must never call `renderPluginArgs`/`renderPluginEnv`, which would replace these
    // with a substituted (in this fake, empty-string) value instead.
    expect(out).toContain("{{apiKey}}")
    expect(out).toContain("{{hostToken}}")
    expect(out).toContain("{{port}}")
  })

  it("never prints the env map in any form — no key, no JSON, no key=value pair", async () => {
    const { run, writer } = harness()
    await run(["install", "/home/me/acme"])
    const out = writer.lines.join("\n")
    // `envTemplate`'s KEYS (`API_KEY`, `SPECTRUM_TOKEN`) are distinct from any arg or
    // secret-field name in this fixture, so their presence anywhere in the output — a
    // `KEY=` pair, a JSON dump, a bare mention — can only mean the env map leaked.
    expect(out).not.toContain("API_KEY")
    expect(out).not.toContain("SPECTRUM_TOKEN")
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

  it("names the offending extension when the registry reports an unsupported api version with an id", async () => {
    const { run } = harness({
      listError: {
        kind: "unsupported-api-version",
        apiVersion: "spectrum.dev/v2",
        id: "acme",
      },
    })
    const r = await run(["list"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("failed")
    if (r.error.kind !== "failed") return
    expect(r.error.detail).toContain("acme")
    expect(r.error.detail).toContain("spectrum.dev/v2")
  })

  it("names the offending extension when the registry reports an invalid manifest with an id", async () => {
    const { run } = harness({
      listError: { kind: "invalid-manifest", detail: "bad shape", id: "acme" },
    })
    const r = await run(["list"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("failed")
    if (r.error.kind !== "failed") return
    expect(r.error.detail).toContain("acme")
    expect(r.error.detail).toContain("bad shape")
  })

  it("does not print the literal string 'undefined' when the registry error carries no id", async () => {
    const { run } = harness({
      listError: { kind: "invalid-manifest", detail: "bad shape" },
    })
    const r = await run(["list"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("failed")
    if (r.error.kind !== "failed") return
    expect(r.error.detail).not.toContain("undefined")
    expect(r.error.detail).toContain("bad shape")
  })
})
