import { describe, expect, it } from "bun:test"
import type { Config } from "@spectrum/config"
import { defaultConfig } from "@spectrum/config"
import { createNoopLogger } from "@spectrum/logger"
import type { SecretRef } from "@spectrum/types"
import { isOk, ok } from "@spectrum/utils"
import { createResetApp } from "./reset-app"

const configWithSecrets = (refs: readonly string[]): Config => {
  const base = defaultConfig()
  return {
    ...base,
    providers: [
      {
        id: "p_1" as never,
        name: "openai",
        sdkProvider: "openai" as never,
        config: {},
        secrets: Object.fromEntries(
          refs.map((r, i) => [`field${i}`, { ref: r } as SecretRef]),
        ),
        models: [],
      },
    ],
  }
}

const makeDeps = (config: Config) => {
  const deleted: string[] = []
  const calls: string[] = []
  return {
    deleted,
    calls,
    deps: {
      config: { load: async () => ok(config), save: async () => ok(undefined) },
      secrets: {
        set: async () => ok({ ref: "x" } as SecretRef),
        get: async () => ok("v"),
        delete: async (ref: SecretRef) => {
          deleted.push(ref.ref)
          return ok(undefined)
        },
        has: async () => true,
      },
      closeDb: () => calls.push("closeDb"),
      removeDir: (dir: string) => calls.push(`removeDir:${dir}`),
      relaunch: () => calls.push("relaunch"),
      dataDir: "/data/Spectrum",
      legacyDirs: [] as readonly string[],
      logger: createNoopLogger(),
    },
  }
}

describe("createResetApp", () => {
  it("deletes every stored secret ref before wiping the data dir", async () => {
    const { deleted, calls, deps } = makeDeps(
      configWithSecrets(["kc_1", "kc_2"]),
    )
    const reset = createResetApp(deps)

    const r = await reset()

    expect(isOk(r)).toBe(true)
    expect(deleted.sort()).toEqual(["kc_1", "kc_2"])
    expect(calls).toEqual(["closeDb", "removeDir:/data/Spectrum", "relaunch"])
  })

  it("still wipes the data dir and relaunches when config has no providers", async () => {
    const { calls, deps } = makeDeps(defaultConfig())
    const reset = createResetApp(deps)

    const r = await reset()

    expect(isOk(r)).toBe(true)
    expect(calls).toEqual(["closeDb", "removeDir:/data/Spectrum", "relaunch"])
  })

  it("continues to wipe + relaunch even if a secret delete fails", async () => {
    const { calls, deps } = makeDeps(configWithSecrets(["kc_1"]))
    const failing = {
      ...deps,
      secrets: {
        ...deps.secrets,
        delete: async () =>
          ({
            ok: false,
            error: { kind: "backend-failed", detail: "x" },
          }) as never,
      },
    }
    const reset = createResetApp(failing)

    const r = await reset()

    expect(isOk(r)).toBe(true)
    expect(calls).toEqual(["closeDb", "removeDir:/data/Spectrum", "relaunch"])
  })

  it("wipes each legacy dir after the data dir and before relaunching", async () => {
    const { calls, deps } = makeDeps(defaultConfig())
    const depsWithLegacy = {
      ...deps,
      legacyDirs: ["/legacy/.config/launchkit", "/legacy/LaunchKit"],
    }
    const reset = createResetApp(depsWithLegacy)

    const r = await reset()

    expect(isOk(r)).toBe(true)
    expect(calls).toEqual([
      "closeDb",
      "removeDir:/data/Spectrum",
      "removeDir:/legacy/.config/launchkit",
      "removeDir:/legacy/LaunchKit",
      "relaunch",
    ])
  })

  it("logs a warning when a secret delete fails, and still completes the reset", async () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const logger = {
      ...createNoopLogger(),
      warn: (msg: string, fields?: Record<string, unknown>) =>
        warns.push(fields === undefined ? { msg } : { msg, fields }),
    }
    const base = makeDeps(configWithSecrets(["kc_1"]))
    const reset = createResetApp({
      ...base.deps,
      secrets: {
        ...base.deps.secrets,
        delete: async () =>
          ({
            ok: false,
            error: { kind: "backend-failed", detail: "x" },
          }) as never,
      },
      logger,
    })
    const r = await reset()
    expect(isOk(r)).toBe(true)
    expect(warns.length).toBe(1)
    expect(warns[0]?.msg).toContain("secret")
  })
})
