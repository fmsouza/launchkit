import { describe, expect, it } from "bun:test"
import { createFakeUpdater } from "./fake-updater"

describe("createFakeUpdater", () => {
  it("starts idle at the given current version", () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0" })
    expect(u.getRaw()).toEqual({
      phase: "idle",
      currentVersion: "1.0.0",
      latestVersion: null,
      latestHash: null,
      available: false,
      progress: 0,
      error: null,
    })
  })

  it("check resolves available and updates the snapshot", async () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0", latest: "1.1.0" })
    const r = await u.check("stable")
    expect(r.ok).toBe(true)
    expect(u.getRaw().phase).toBe("available")
    expect(u.getRaw().available).toBe(true)
    expect(u.getRaw().latestVersion).toBe("1.1.0")
  })

  it("check resolves up-to-date when no newer version", async () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0" })
    await u.check("stable")
    expect(u.getRaw().phase).toBe("up-to-date")
    expect(u.getRaw().available).toBe(false)
  })

  it("check returns offline error when scripted to fail", async () => {
    const u = createFakeUpdater({
      currentVersion: "1.0.0",
      failCheck: "offline",
    })
    const r = await u.check("stable")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("offline")
    expect(u.getRaw().phase).toBe("error")
  })

  it("startDownload drives the snapshot to downloaded", () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0", latest: "1.1.0" })
    u.startDownload()
    expect(u.getRaw().phase).toBe("downloaded")
    expect(u.getRaw().progress).toBe(1)
  })

  it("setChannel records the channel and re-checks", async () => {
    const u = createFakeUpdater({
      currentVersion: "1.0.0",
      latest: "2.0.0-canary",
    })
    const r = await u.setChannel("canary")
    expect(r.ok).toBe(true)
    expect(u.lastChannel).toBe("canary")
  })

  it("getBuildChannel returns the configured build channel", async () => {
    const u = createFakeUpdater({
      currentVersion: "1.0.0",
      buildChannel: "canary",
    })
    expect(await u.getBuildChannel()).toBe("canary")
  })

  it("getBuildChannel returns undefined when no build channel is configured", async () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0" })
    expect(await u.getBuildChannel()).toBeUndefined()
  })

  it("getBuildChannel reflects a setChannel switch", async () => {
    const u = createFakeUpdater({
      currentVersion: "1.0.0",
      buildChannel: "stable",
    })
    await u.setChannel("canary")
    expect(await u.getBuildChannel()).toBe("canary")
  })

  it("relaunch records the call and resolves ok", async () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0" })
    expect(u.relaunchCalls).toBe(0)
    const r = await u.relaunch()
    expect(r.ok).toBe(true)
    expect(u.relaunchCalls).toBe(1)
  })

  it("check records the call count for handler relaunch-vs-check assertions", async () => {
    const u = createFakeUpdater({ currentVersion: "1.0.0", latest: "1.1.0" })
    expect(u.checkCalls).toBe(0)
    await u.check("stable")
    expect(u.checkCalls).toBe(1)
  })
})
