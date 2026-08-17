import { describe, expect, it } from "bun:test"
import type { Config, PluginInstall } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import { PluginIdSchema, ProviderIdSchema } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { createExtensionAdmin } from "./extension-admin"

const pid = (id: string) => PluginIdSchema.parse(id)

const acmeInstall: PluginInstall = {
  id: pid("acme"),
  source: {
    kind: "git",
    url: "https://e.com/a.git",
    ref: "HEAD",
    commit: "c1",
  },
  enabled: true,
}

const acmeManifest = {
  apiVersion: "spectrum.dev/v1",
  id: pid("acme"),
  name: "Acme",
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: pid("acme"),
        descriptor: {
          label: "Acme",
          configFields: [],
          secretFields: [],
          supportsCustomHeaders: false,
          streaming: "incremental" as const,
          reasoning: { shape: "none" as const, supportedTiers: [] },
          discovery: { strategy: "none" as const },
          actions: [],
        },
        transport: { kind: "http" as const, wire: "openai" as const },
      },
    ],
  },
}

const harness = (opts?: {
  config?: Config
  installFails?: boolean
}) => {
  let stored: Config = opts?.config ?? defaultConfig()
  const refreshes: number[] = []
  const stopped: string[] = []
  const admin = createExtensionAdmin({
    config: {
      load: async () => ok(stored),
      save: async (next: Config) => {
        stored = next
        return ok(undefined)
      },
    },
    installer: {
      install: async () =>
        opts?.installFails === true
          ? err({ kind: "git-failed", detail: "exit 128" })
          : ok({
              manifest: acmeManifest,
              install: acmeInstall,
              ignoredContributions: [],
            }),
      update: async () =>
        ok({
          manifest: acmeManifest,
          install: {
            ...acmeInstall,
            source: { ...acmeInstall.source, commit: "c2" },
          },
          ignoredContributions: [],
        }),
      remove: async () => ok(undefined),
    },
    registry: {
      list: async () =>
        ok([
          { manifest: acmeManifest, ignoredContributions: [], dir: "/d/acme" },
        ]),
      providerDescriptors: async () => ok([]),
    },
    providerHost: {
      ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
      status: () => "stopped",
      stop: async () => {},
      stopAllFor: async (id: string) => {
        stopped.push(id)
      },
      stopAll: async () => {},
      retainOnly: async () => {},
    },
    refresh: async () => {
      refreshes.push(Date.now())
    },
  })
  return { admin, refreshes, stopped, read: (): Config => stored }
}

describe("createExtensionAdmin", () => {
  it("records the install and refreshes the extension view when installing", async () => {
    const { admin, refreshes, read } = harness()
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(true)
    expect(read().providerPlugins.map((p) => String(p.id))).toEqual(["acme"])
    expect(refreshes.length).toBe(1)
  })

  it("writes nothing and does not refresh when the install fails", async () => {
    const { admin, refreshes, read } = harness({ installFails: true })
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    expect(read().providerPlugins).toEqual([])
    expect(refreshes.length).toBe(0)
  })

  it("flips enabled in config and refreshes when disabling", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, read } = harness({ config: cfg })
    const r = await admin.setEnabled(pid("acme"), false)
    expect(r.ok).toBe(true)
    expect(read().providerPlugins[0]?.enabled).toBe(false)
    expect(refreshes.length).toBe(1)
  })

  it("fails with not-found when enabling an id with no install record", async () => {
    const { admin } = harness()
    const r = await admin.setEnabled(pid("ghost"), true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-found")
  })

  it("refuses to remove and names the referencing providers when one is configured", async () => {
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [
        {
          id: ProviderIdSchema.parse("prv_1"),
          name: "Acme",
          sdkProvider: "plugin:acme",
          config: {},
          secrets: {},
          models: [],
        },
      ],
    }
    const { admin, read } = harness({ config: cfg })
    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "in-use")
      expect(r.error.providerIds).toEqual(["prv_1"])
    expect(read().providerPlugins.length).toBe(1)
  })

  it("stops every contributed provider's children before deleting the files", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, stopped } = harness({ config: cfg })
    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)
    expect(stopped).toEqual(["acme"])
  })

  it("drops the install record and refreshes when a removal succeeds", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, read } = harness({ config: cfg })
    await admin.remove(pid("acme"))
    expect(read().providerPlugins).toEqual([])
    expect(refreshes.length).toBe(1)
  })

  it("records the new commit and refreshes when updating", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, read } = harness({ config: cfg })
    const r = await admin.update(pid("acme"))
    expect(r.ok).toBe(true)
    const source = read().providerPlugins[0]?.source
    if (source?.kind === "git") expect(source.commit).toBe("c2")
    expect(refreshes.length).toBe(1)
  })
})
