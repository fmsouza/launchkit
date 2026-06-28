import { describe, expect, it } from "bun:test"

import { err, ok } from "@spectrum/utils"

import type { ConfigStore } from "@spectrum/config"
import type { Config } from "@spectrum/config"
import { buildUpdateState } from "./build-update-state"
import { createFakeUpdater } from "./fake-updater"

/** Minimal fake ConfigStore for tests — no real fs interaction. */
const makeFakeConfig = (
  overrides?: Partial<Config["settings"]>,
): ConfigStore => ({
  load: async () =>
    ok({
      version: 1 as const,
      providers: [],
      models: [],
      settings: {
        proxyHost: "127.0.0.1",
        proxyPort: 0,
        firstTokenTimeoutMs: 30000,
        interTokenTimeoutMs: 10000,
        updateChannel: "stable" as const,
        lastSelectedFolder: "",
        lastSelectedHarnessId: "",
        collapsedProjects: [],
        dismissedUpdateVersion: null,
        dismissedUpdateHash: null,
        lastByHarness: {},
        ...overrides,
      },
    }),
  save: async (cfg) => ok(cfg),
})

describe("buildUpdateState", () => {
  it("showBanner is true when an update is available and not dismissed", async () => {
    const updater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashA",
      buildChannel: "stable",
    })
    await updater.check("stable")
    const config = makeFakeConfig({
      dismissedUpdateHash: null,
      dismissedUpdateVersion: null,
    })

    const state = await buildUpdateState({ updater, config })

    expect(state.showBanner).toBe(true)
    expect(state.available).toBe(true)
    expect(state.latestVersion).toBe("1.1.0")
    expect(state.channel).toBe("stable")
  })

  it("showBanner is false when the latestHash matches the dismissed hash", async () => {
    const updater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashA",
      buildChannel: "stable",
    })
    await updater.check("stable")
    const config = makeFakeConfig({ dismissedUpdateHash: "hashA" })

    const state = await buildUpdateState({ updater, config })

    expect(state.showBanner).toBe(false)
    expect(state.available).toBe(true)
  })

  it("channel falls back to config's updateChannel when getBuildChannel returns undefined", async () => {
    const updater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashB",
      // No buildChannel — getBuildChannel() returns undefined
    })
    await updater.check("canary")
    const config = makeFakeConfig({
      updateChannel: "canary",
      dismissedUpdateHash: null,
    })

    const state = await buildUpdateState({ updater, config })

    expect(state.channel).toBe("canary")
  })

  it("channel falls back to stable when the config fails to load and getBuildChannel returns undefined", async () => {
    const updater = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "1.1.0",
      latestHash: "hashC",
      // No buildChannel — getBuildChannel() returns undefined
    })
    await updater.check("canary")
    const config: ConfigStore = {
      load: async () => err({ kind: "not-found" }),
      save: async (cfg) => ok(cfg),
    }

    const state = await buildUpdateState({ updater, config })

    expect(state.channel).toBe("stable")
  })
})
