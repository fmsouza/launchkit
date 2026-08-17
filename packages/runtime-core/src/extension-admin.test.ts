import { describe, expect, it } from "bun:test"
import type { Config, PluginInstall } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import type { Logger } from "@spectrum/logger"
import { PluginIdSchema, ProviderIdSchema } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { createExtensionAdmin } from "./extension-admin"

const pid = (id: string) => PluginIdSchema.parse(id)

// Manifest id ("acme") and CONTRIBUTION id ("acme-chat") are deliberately DIFFERENT: a fixture
// where both are the same string cannot tell a caller that swaps one for the other apart, and
// `stopAllFor`/`in-use` are keyed on the CONTRIBUTION id, never the manifest id.
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
        id: pid("acme-chat"),
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

/**
 * A flow runner with nothing live, for the call sites whose scenario has no setup flow running.
 * Deliberately NOT a default inside `createExtensionAdmin`: the dep is required there so a
 * wiring omission is a type error rather than a class of flows that hang with no error.
 */
const inertFlowRunner = {
  start: async () => err({ kind: "not-found" as const, id: "unused" }),
  advance: async () => err({ kind: "not-found" as const, id: "unused" }),
  takeCompletion: () => undefined,
  cancel: async () => {},
  activeInstanceKeys: () => new Set<string>(),
  abandon: () => {},
}

type LogEntry = {
  readonly level: "debug" | "info" | "warn" | "error" | "fatal"
  readonly msg: string
  readonly fields?: Record<string, unknown>
}

/** Captures every call instead of writing anywhere — lets a test assert WHICH line was logged
 * (mutation vs. refusal vs. warning) without depending on log formatting. */
const captureLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = []
  const record =
    (level: LogEntry["level"]) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, msg, ...(fields === undefined ? {} : { fields }) })
    }
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => logger,
  }
  return { logger, entries }
}

const harness = (opts?: {
  config?: Config
  installFails?: boolean
  saveFails?: boolean
  listFails?: boolean
  logger?: Logger
  /** Instance keys the flow runner reports as live while this scenario runs. */
  liveFlowKeys?: readonly string[]
}) => {
  let stored: Config = opts?.config ?? defaultConfig()
  const refreshes: number[] = []
  const stopped: string[] = []
  const stopAllCalls: number[] = []
  const installerRemoveCalls: string[] = []
  const abandoned: Array<{ keys: readonly string[]; reason: string }> = []
  /** Interleaving of `abandon` with the host's kill calls — the runner must be told FIRST. */
  const order: string[] = []
  const admin = createExtensionAdmin({
    config: {
      load: async () => ok(stored),
      save: async (next: Config) => {
        if (opts?.saveFails === true)
          return err({
            kind: "write-failed",
            detail: "EACCES: permission denied",
          })
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
      remove: async (id) => {
        installerRemoveCalls.push(String(id))
        return ok(undefined)
      },
    },
    registry: async () => ({
      list: async () =>
        opts?.listFails === true
          ? err({
              kind: "invalid-manifest",
              detail: "some other extension's manifest is broken",
            })
          : ok([
              {
                manifest: acmeManifest,
                ignoredContributions: [],
                dir: "/d/acme",
              },
            ]),
      providerDescriptors: async () => ok([]),
    }),
    providerHost: {
      ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
      status: () => "stopped",
      stop: async () => {},
      stopAllFor: async (id: string) => {
        order.push("stopAllFor")
        stopped.push(id)
      },
      stopAll: async () => {
        order.push("stopAll")
        stopAllCalls.push(1)
      },
      retainOnly: async () => {},
    },
    flowRunner: {
      start: async () => err({ kind: "not-found", id: "unused" }),
      advance: async () => err({ kind: "not-found", id: "unused" }),
      takeCompletion: () => undefined,
      cancel: async () => {},
      activeInstanceKeys: () => new Set(opts?.liveFlowKeys ?? []),
      abandon: (keys: readonly string[], reason: string) => {
        order.push("abandon")
        abandoned.push({ keys: [...keys], reason })
      },
    },
    refresh: async () => {
      refreshes.push(Date.now())
    },
    ...(opts?.logger === undefined ? {} : { logger: opts.logger }),
  })
  return {
    admin,
    refreshes,
    stopped,
    stopAllCalls,
    installerRemoveCalls,
    abandoned,
    order,
    read: (): Config => stored,
  }
}

describe("createExtensionAdmin", () => {
  it("records the install and refreshes the extension view when installing", async () => {
    const { admin, refreshes, read } = harness()
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(true)
    expect(read().providerPlugins.map((p) => String(p.id))).toEqual(["acme"])
    expect(refreshes.length).toBe(1)
  })

  it("resolves with the installed extension's manifest and install record", async () => {
    const { admin } = harness()
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(String(r.value.manifest.id)).toBe("acme")
      expect(String(r.value.install.id)).toBe("acme")
    }
  })

  it("writes nothing and does not refresh when the install fails", async () => {
    const { admin, refreshes, read } = harness({ installFails: true })
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    expect(read().providerPlugins).toEqual([])
    expect(refreshes.length).toBe(0)
  })

  it("rolls back the installer's write when the config save fails after a successful install", async () => {
    const { admin, refreshes, installerRemoveCalls } = harness({
      saveFails: true,
    })
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("write-failed")
    expect(installerRemoveCalls).toEqual(["acme"])
    expect(refreshes.length).toBe(0)
  })

  it("flips enabled in config and refreshes when disabling, without stopping any children", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, stopped, read } = harness({ config: cfg })
    const r = await admin.setEnabled(pid("acme"), false)
    expect(r.ok).toBe(true)
    expect(read().providerPlugins[0]?.enabled).toBe(false)
    expect(refreshes.length).toBe(1)
    expect(stopped).toEqual([])
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
          sdkProvider: "plugin:acme-chat",
          config: {},
          secrets: {},
          models: [],
        },
      ],
    }
    const { admin, read } = harness({ config: cfg })
    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("in-use")
    if (!r.ok && r.error.kind === "in-use")
      expect(r.error.providerIds).toEqual(["prv_1"])
    expect(read().providerPlugins.length).toBe(1)
  })

  it("logs the in-use refusal as a distinct refusal line, not as a mutation", async () => {
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [
        {
          id: ProviderIdSchema.parse("prv_1"),
          name: "Acme",
          sdkProvider: "plugin:acme-chat",
          config: {},
          secrets: {},
          models: [],
        },
      ],
    }
    const { logger, entries } = captureLogger()
    const { admin } = harness({ config: cfg, logger })
    await admin.remove(pid("acme"))
    expect(entries.some((e) => e.msg === "extension admin refusal")).toBe(true)
    expect(
      entries.some(
        (e) =>
          e.msg === "extension admin mutation" && e.fields?.op === "remove",
      ),
    ).toBe(false)
  })

  it("stops the CONTRIBUTED provider's children (not the manifest id) before deleting the files", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, stopped } = harness({ config: cfg })
    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)
    expect(stopped).toEqual(["acme-chat"])
  })

  it("abandons the removed contribution's live flows — and only those — before stopping its children", async () => {
    // `stopAllFor` stops and forgets with no callback and no reason code, and `host.status`
    // reports "stopped" identically for a killed child, a crashed one, and a key that never
    // existed, so the runner cannot discover why its child died and must be told FIRST.
    // A flow of a DIFFERENT contribution is untouched here: this stop is targeted, so
    // abandoning more than it kills would end a flow whose child is still alive.
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, abandoned, order } = harness({
      config: cfg,
      liveFlowKeys: ["flow:acme-chat:n0", "flow:other-chat:n1"],
    })

    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)

    expect(abandoned.at(-1)).toEqual({
      keys: ["flow:acme-chat:n0"],
      reason: "extension-disabled",
    })
    expect(order.slice(0, 2)).toEqual(["abandon", "stopAllFor"])
  })

  it("drops the install record and refreshes when a removal succeeds", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, read } = harness({ config: cfg })
    await admin.remove(pid("acme"))
    expect(read().providerPlugins).toEqual([])
    expect(refreshes.length).toBe(1)
  })

  it("removes on the happy path in the documented order: load, list, load, stop, delete, load, save, refresh", async () => {
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [],
    }
    const calls: string[] = []
    const admin = createExtensionAdmin({
      config: {
        load: async () => {
          calls.push("load")
          return ok(cfg)
        },
        save: async () => {
          calls.push("save")
          return ok(undefined)
        },
      },
      installer: {
        install: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        remove: async () => {
          calls.push("delete")
          return ok(undefined)
        },
      },
      registry: async () => ({
        list: async () => {
          calls.push("list")
          return ok([
            {
              manifest: acmeManifest,
              ignoredContributions: [],
              dir: "/d/acme",
            },
          ])
        },
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {
          calls.push("stop")
        },
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {
        calls.push("refresh")
      },
    })

    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      "load",
      "list",
      "load",
      "stop",
      "delete",
      "load",
      "save",
      "refresh",
    ])
  })

  it("writes from the load taken AFTER the delete, not the earlier pre-delete re-check load — a concurrent edit during the delete survives", async () => {
    // Sabotage-proof for the round-2 fix: asserting that a THIRD `load` call HAPPENS (the
    // ordering test above) does not prove the write uses ITS value rather than the second
    // (pre-delete) load's. Building `next` from `freshCfg` while still taking a third load
    // would leave this fully green — only asserting on the WRITTEN content catches it.
    let stored: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [],
    }
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
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        remove: async () => {
          // Simulate a concurrent, UNRELATED config write landing WHILE the delete is in
          // progress — after the pre-delete re-check load, before the post-delete write load.
          stored = {
            ...stored,
            providers: [
              {
                id: ProviderIdSchema.parse("prv_other"),
                name: "Other",
                sdkProvider: "openai",
                config: {},
                secrets: {},
                models: [],
              },
            ],
          }
          return ok(undefined)
        },
      },
      registry: async () => ({
        list: async () =>
          ok([
            {
              manifest: acmeManifest,
              ignoredContributions: [],
              dir: "/d/acme",
            },
          ]),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {},
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })

    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)
    expect(stored.providerPlugins).toEqual([])
    // The concurrently-added, UNRELATED provider record — added DURING the delete — must
    // survive the write. It would be erased if the write were built from the earlier
    // pre-delete `freshCfg` instead of a load taken after `installer.remove` returns.
    expect(stored.providers.map((p) => String(p.id))).toEqual(["prv_other"])
  })

  it("records the new commit, refreshes, and resolves with the updated extension", async () => {
    const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
    const { admin, refreshes, read } = harness({ config: cfg })
    const r = await admin.update(pid("acme"))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const source = r.value.install.source
      expect(source.kind).toBe("git")
      if (source.kind === "git") expect(source.commit).toBe("c2")
    }
    const source = read().providerPlugins[0]?.source
    expect(source?.kind).toBe("git")
    if (source?.kind === "git") expect(source.commit).toBe("c2")
    expect(refreshes.length).toBe(1)
  })

  it("re-loads config for the write, instead of erasing a concurrent config change", async () => {
    let loadCount = 0
    let stored: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [],
    }
    const admin = createExtensionAdmin({
      config: {
        load: async () => {
          loadCount += 1
          // Simulate an UNRELATED concurrent edit landing between `update`'s first load (used
          // to find the current install record) and the late re-load right before the write.
          if (loadCount === 2) {
            stored = {
              ...stored,
              providers: [
                {
                  id: ProviderIdSchema.parse("prv_other"),
                  name: "Other",
                  sdkProvider: "openai",
                  config: {},
                  secrets: {},
                  models: [],
                },
              ],
            }
          }
          return ok(stored)
        },
        save: async (next: Config) => {
          stored = next
          return ok(undefined)
        },
      },
      installer: {
        install: async () =>
          ok({
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
      registry: async () => ({
        list: async () => ok([]),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {},
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })

    const r = await admin.update(pid("acme"))
    expect(r.ok).toBe(true)
    const source = stored.providerPlugins[0]?.source
    expect(source?.kind).toBe("git")
    if (source?.kind === "git") expect(source.commit).toBe("c2")
    // The concurrently-added, UNRELATED provider record must survive the write.
    expect(stored.providers.map((p) => String(p.id))).toEqual(["prv_other"])
  })

  describe("when registry.list() fails (a DIFFERENT extension's manifest is broken)", () => {
    it("still removes the extension by degrading to a full provider-host stop, instead of refusing", async () => {
      const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
      const { admin, stopped, stopAllCalls, refreshes, read } = harness({
        config: cfg,
        listFails: true,
      })
      const r = await admin.remove(pid("acme"))
      expect(r.ok).toBe(true)
      // Cannot enumerate this extension's OWN contributions when the batch listing failed, so
      // it stops EVERYTHING rather than nothing — conservative, not targeted.
      expect(stopAllCalls.length).toBe(1)
      expect(stopped).toEqual([])
      expect(read().providerPlugins).toEqual([])
      expect(refreshes.length).toBe(1)
    })

    it("abandons EVERY live flow — including unrelated extensions' — before the degraded stopAll", async () => {
      // The degraded branch kills every supervised child, not just this extension's, so the
      // flow children of extensions that have nothing to do with this removal die too.
      //
      // The trailing `config.save` sweep does NOT cover them: those extensions are still
      // installed and still enabled, so `flowIsRetained` RETAINS their keys and never abandons
      // them — and `retainOnly` does not resurrect an already-stopped child. Without this the
      // sessions stay live forever and the user gets the raw transport error permanently,
      // which is the exact failure `abandon` exists to prevent.
      const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
      const { admin, abandoned, order } = harness({
        config: cfg,
        listFails: true,
        liveFlowKeys: ["flow:acme-chat:n0", "flow:other-chat:n1"],
      })

      const r = await admin.remove(pid("acme"))
      expect(r.ok).toBe(true)

      expect(abandoned.at(-1)).toEqual({
        keys: ["flow:acme-chat:n0", "flow:other-chat:n1"],
        reason: "extension-disabled",
      })
      expect(order.slice(0, 2)).toEqual(["abandon", "stopAll"])
    })

    it("does not compute or enforce the in-use guard, even if a provider still references the extension", async () => {
      const cfg: Config = {
        ...defaultConfig(),
        providerPlugins: [acmeInstall],
        providers: [
          {
            id: ProviderIdSchema.parse("prv_1"),
            name: "Acme",
            sdkProvider: "plugin:acme-chat",
            config: {},
            secrets: {},
            models: [],
          },
        ],
      }
      const { admin, stopAllCalls } = harness({ config: cfg, listFails: true })
      const r = await admin.remove(pid("acme"))
      expect(r.ok).toBe(true)
      // Still stops (conservatively) even though `in-use` was never checked — a degraded
      // removal must not leave an unreachable extension's children running just because the
      // gate that would have named the referencing provider couldn't run.
      expect(stopAllCalls.length).toBe(1)
    })

    it("logs a warning naming the listing failure's kind, bounded in length", async () => {
      const cfg = { ...defaultConfig(), providerPlugins: [acmeInstall] }
      const { logger, entries } = captureLogger()
      const { admin } = harness({ config: cfg, listFails: true, logger })
      await admin.remove(pid("acme"))
      const warning = entries.find(
        (e) =>
          e.level === "warn" &&
          typeof e.fields?.kind === "string" &&
          e.fields.kind === "invalid-manifest",
      )
      expect(warning).toBeDefined()
      const detail = warning?.fields?.detail
      expect(typeof detail).toBe("string")
      expect((detail as string).length).toBeLessThanOrEqual(201)
    })
  })

  it("preserves the underlying config error detail instead of collapsing every kind to its name", async () => {
    const admin = createExtensionAdmin({
      config: {
        load: async () =>
          err({ kind: "parse-failed", detail: "Unexpected token } in JSON" }),
        save: async () => ok(undefined),
      },
      installer: {
        install: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () => err({ kind: "not-found", id: "acme" }),
        remove: async () => ok(undefined),
      },
      registry: async () => ({
        list: async () => ok([]),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {},
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })
    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "read-failed") {
      expect(r.error.detail).toBe("parse-failed: Unexpected token } in JSON")
    } else {
      throw new Error("expected a read-failed PluginError")
    }
  })

  it("re-checks in-use BEFORE anything destructive, refusing a removal a provider record raced in after the first check", async () => {
    const cfg: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [],
    }
    let loadCount = 0
    let stored: Config = cfg
    const removeCalls: string[] = []
    const stopAllForCalls: string[] = []
    let stopAllCalls = 0
    const admin = createExtensionAdmin({
      config: {
        load: async () => {
          loadCount += 1
          // The SECOND load is the pre-delete/pre-save re-check. Simulate a concurrent write
          // landing between the first `in-use` check and this point: a provider referencing the
          // extension's contribution now exists, even though the first check saw none.
          if (loadCount === 2) {
            stored = {
              ...stored,
              providers: [
                {
                  id: ProviderIdSchema.parse("prv_race"),
                  name: "Acme",
                  sdkProvider: "plugin:acme-chat",
                  config: {},
                  secrets: {},
                  models: [],
                },
              ],
            }
          }
          return ok(stored)
        },
        save: async (next: Config) => {
          stored = next
          return ok(undefined)
        },
      },
      installer: {
        install: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        remove: async (id) => {
          removeCalls.push(String(id))
          return ok(undefined)
        },
      },
      registry: async () => ({
        list: async () =>
          ok([
            {
              manifest: acmeManifest,
              ignoredContributions: [],
              dir: "/d/acme",
            },
          ]),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async (contributionId: string) => {
          stopAllForCalls.push(contributionId)
        },
        stopAll: async () => {
          stopAllCalls += 1
        },
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })

    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("in-use")
    if (!r.ok && r.error.kind === "in-use")
      expect(r.error.providerIds).toEqual(["prv_race"])
    // The re-check must fire BEFORE anything destructive: nothing was stopped, nothing was
    // deleted, and the install record is untouched — a refusal must leave config and disk in
    // the SAME consistent state they were in before `remove` was called, not a state where
    // config still claims the extension installed while its files are already gone.
    expect(stopAllForCalls).toEqual([])
    expect(stopAllCalls).toBe(0)
    expect(removeCalls).toEqual([])
    expect(stored.providerPlugins.length).toBe(1)
  })

  it("rolls back the installer's write when the config LOAD fails after a successful install (not just the save)", async () => {
    const installerRemoveCalls: string[] = []
    const admin = createExtensionAdmin({
      config: {
        load: async () => err({ kind: "parse-failed", detail: "bad json" }),
        save: async () => ok(undefined),
      },
      installer: {
        install: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () => err({ kind: "not-found", id: "acme" }),
        remove: async (id) => {
          installerRemoveCalls.push(String(id))
          return ok(undefined)
        },
      },
      registry: async () => ({
        list: async () => ok([]),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {},
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })

    const r = await admin.install({ source: "https://e.com/a.git" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("read-failed")
    expect(installerRemoveCalls).toEqual(["acme"])
  })

  it("re-loads config for the WRITE even on the degraded (listing-failed) remove path, instead of erasing a concurrent config change", async () => {
    let loadCount = 0
    let stored: Config = {
      ...defaultConfig(),
      providerPlugins: [acmeInstall],
      providers: [],
    }
    const admin = createExtensionAdmin({
      config: {
        load: async () => {
          loadCount += 1
          // Simulate a totally UNRELATED concurrent edit landing between the first load and
          // the pre-write re-load — nothing to do with this extension's `in-use` status, just
          // an ordinary config change that a stale read-modify-write would silently discard.
          if (loadCount === 2) {
            stored = {
              ...stored,
              providers: [
                {
                  id: ProviderIdSchema.parse("prv_other"),
                  name: "Other",
                  sdkProvider: "openai",
                  config: {},
                  secrets: {},
                  models: [],
                },
              ],
            }
          }
          return ok(stored)
        },
        save: async (next: Config) => {
          stored = next
          return ok(undefined)
        },
      },
      installer: {
        install: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        update: async () =>
          ok({
            manifest: acmeManifest,
            install: acmeInstall,
            ignoredContributions: [],
          }),
        remove: async () => ok(undefined),
      },
      registry: async () => ({
        // Listing fails -> the degraded path, which never computes `in-use` or contribution
        // keys — the write must still be based on the FRESH config, not the first load.
        list: async () => err({ kind: "invalid-manifest", detail: "broken" }),
        providerDescriptors: async () => ok([]),
      }),
      providerHost: {
        ensureRunning: async () => err({ kind: "not-found", id: "unused" }),
        status: () => "stopped",
        stop: async () => {},
        stopAllFor: async () => {},
        stopAll: async () => {},
        retainOnly: async () => {},
      },
      flowRunner: inertFlowRunner,
      refresh: async () => {},
    })

    const r = await admin.remove(pid("acme"))
    expect(r.ok).toBe(true)
    expect(stored.providerPlugins).toEqual([])
    // The concurrently-added, UNRELATED provider record must survive the write.
    expect(stored.providers.map((p) => String(p.id))).toEqual(["prv_other"])
  })
})
