import { describe, expect, it } from "bun:test"
import { createElectrobunUpdater } from "./electrobun-updater"
import type { UpdaterEngine } from "./electrobun-updater"

const baseEngine = (over: Partial<UpdaterEngine> = {}): UpdaterEngine => ({
  checkForUpdate: async () => ({
    version: "1.0.0",
    hash: "h",
    updateAvailable: false,
  }),
  downloadUpdate: async () => {},
  applyUpdate: async () => {},
  onStatusChange: () => {},
  localInfo: { version: async () => "1.0.0" },
  ...over,
})

describe("createElectrobunUpdater", () => {
  it("maps an available check to the available phase", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          checkForUpdate: async () => ({
            version: "1.1.0",
            hash: "h2",
            updateAvailable: true,
          }),
        }),
    })
    const r = await u.check("stable")
    expect(r.ok).toBe(true)
    expect(u.getRaw().phase).toBe("available")
    expect(u.getRaw().latestVersion).toBe("1.1.0")
    expect(u.getRaw().currentVersion).toBe("1.0.0")
  })

  it("populates latestHash from the feed hash when an update is available", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          checkForUpdate: async () => ({
            version: "1.4.0",
            hash: "1wg7wj2g0bm4w",
            updateAvailable: true,
          }),
        }),
    })
    await u.check("canary")
    expect(u.getRaw().latestHash).toBe("1wg7wj2g0bm4w")
  })

  it("sets latestHash to null when up-to-date", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          checkForUpdate: async () => ({
            version: "1.4.0",
            hash: "h",
            updateAvailable: false,
          }),
        }),
    })
    await u.check("stable")
    expect(u.getRaw().latestHash).toBeNull()
  })

  it("coerces a missing updateAvailable to a boolean false (up-to-date path)", async () => {
    // Electrobun's real Updater.checkForUpdate returns the raw parsed update.json on
    // the hash-matches path — which has NO `updateAvailable` field (undefined). The
    // strict UpdateStateSchema requires `available: boolean`, so an undefined here makes
    // the IPC result-validation throw and the check toast "Couldn't check for updates."
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          checkForUpdate: async () => ({ version: "1.0.0", hash: "h" }),
        }),
    })
    const r = await u.check("stable")
    expect(r.ok).toBe(true)
    expect(u.getRaw().phase).toBe("up-to-date")
    expect(u.getRaw().available).toBe(false)
    expect(u.getRaw().latestVersion).toBeNull()
  })

  it("maps a failed check fetch to an offline error", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          checkForUpdate: async () => {
            throw new Error("network down")
          },
        }),
    })
    const r = await u.check("stable")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("offline")
    expect(u.getRaw().phase).toBe("error")
  })

  it("relays download status entries into the raw snapshot", async () => {
    let emit:
      | ((e: { status: string; details?: { progress?: number } }) => void)
      | null = null
    // Deferred resolve lets us capture the mid-download progress before completion
    let resolveDownload!: () => void
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          onStatusChange: (cb) => {
            emit = cb
          },
          downloadUpdate: () =>
            new Promise<void>((resolve) => {
              resolveDownload = resolve
              // Electrobun emits progress as a 0–100 percentage; verify normalization to 0–1
              emit?.({ status: "download-progress", details: { progress: 50 } })
            }),
        }),
    })
    await u.check("stable")
    u.startDownload()
    await new Promise((r) => setTimeout(r, 0))
    // Mid-download: percentage 50 must be normalized to 0.5 (not forwarded verbatim)
    expect(u.getRaw().progress).toBe(0.5)
    // Now complete the download
    emit?.({ status: "download-complete" })
    resolveDownload()
    await new Promise((r) => setTimeout(r, 0))
    expect(u.getRaw().phase).toBe("downloaded")
  })

  it("clamps an out-of-range download-progress percentage to [0,1]", async () => {
    let emit:
      | ((e: { status: string; details?: { progress?: number } }) => void)
      | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          onStatusChange: (cb) => {
            emit = cb
          },
          downloadUpdate: async () => {
            emit?.({ status: "download-progress", details: { progress: 150 } })
          },
        }),
    })
    await u.check("stable")
    u.startDownload()
    await new Promise((r) => setTimeout(r, 0))
    expect(u.getRaw().progress).toBe(1)
  })

  it("does not regress phase to error when a late error event follows download-complete", async () => {
    let emit:
      | ((e: { status: string; details?: { progress?: number } }) => void)
      | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () =>
        baseEngine({
          onStatusChange: (cb) => {
            emit = cb
          },
          downloadUpdate: async () => {
            emit?.({ status: "download-complete" })
            emit?.({ status: "error" })
          },
        }),
    })
    await u.check("stable")
    u.startDownload()
    await new Promise((r) => setTimeout(r, 0))
    expect(u.getRaw().phase).toBe("downloaded")
  })

  it("setChannel rewrites the channel field in version.json", async () => {
    const initialJson = JSON.stringify({
      identifier: "x",
      channel: "stable",
      version: "1.0.0",
      hash: "h",
      baseUrl: "u",
      name: "Spectrum",
    })
    let written: string | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => initialJson,
        write: async (contents) => {
          written = contents
        },
      },
    })
    const r = await u.setChannel("canary")
    expect(r.ok).toBe(true)
    expect(written).not.toBeNull()
    const parsed = JSON.parse(written ?? "") as Record<string, unknown>
    expect(parsed.channel).toBe("canary")
    expect(parsed.version).toBe("1.0.0")
    expect(parsed.hash).toBe("h")
    expect(parsed.baseUrl).toBe("u")
  })

  it("getBuildChannel reads the channel field from version.json", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () =>
          JSON.stringify({ channel: "canary", version: "1.2.3", hash: "h" }),
        write: async () => {},
      },
    })
    expect(await u.getBuildChannel()).toBe("canary")
  })

  it("getBuildChannel returns undefined when version.json is unreadable", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => {
          throw new Error("no bundle")
        },
        write: async () => {},
      },
    })
    expect(await u.getBuildChannel()).toBeUndefined()
  })

  it("getBuildChannel returns undefined for a non-Channel value (e.g. dev)", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => JSON.stringify({ channel: "dev", version: "1.2.3" }),
        write: async () => {},
      },
    })
    expect(await u.getBuildChannel()).toBeUndefined()
  })

  it("setChannel resolves ok even when the version file write fails", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () =>
          JSON.stringify({
            identifier: "x",
            channel: "stable",
            version: "1.0.0",
            hash: "h",
            baseUrl: "u",
            name: "Spectrum",
          }),
        write: async () => {
          throw new Error("read-only filesystem")
        },
      },
    })
    const r = await u.setChannel("canary")
    expect(r.ok).toBe(true)
  })

  // ── Cross-channel migration: rewrite BOTH channel + name ───────────────────
  // The bug: setChannel rewrote only `channel`, leaving the stable bundle's
  // name "Spectrum". After restart, Electrobun builds the full-bundle URL from
  // localInfo.name → `canary-<os>-<arch>-Spectrum.app.tar.zst`, which 404s (the
  // canary asset is `Spectrum-canary.app.tar.zst`). Rewriting `name` to the
  // target channel's bundle name makes the running app request the real asset.

  it("setChannel rewrites name alongside channel on a cross-channel switch (stable→canary)", async () => {
    const initialJson = JSON.stringify({
      identifier: "dev.spectrum.app",
      channel: "stable",
      version: "1.8.0",
      hash: "stableHash",
      baseUrl: "u",
      name: "Spectrum",
    })
    let written: string | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => initialJson,
        write: async (contents) => {
          written = contents
        },
      },
    })
    const r = await u.setChannel("canary")
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(written ?? "") as Record<string, unknown>
    expect(parsed.channel).toBe("canary")
    // The canary bundle is named "Spectrum-canary" (getAppFileName), so the
    // post-restart app requests `...-Spectrum-canary.app.tar.zst` (HTTP 200),
    // not the 404 `...-Spectrum.app.tar.zst`.
    expect(parsed.name).toBe("Spectrum-canary")
  })

  it("setChannel rewrites name back to Spectrum on a canary→stable switch", async () => {
    const initialJson = JSON.stringify({
      identifier: "dev.spectrum.app",
      channel: "canary",
      version: "1.8.0-canary.2",
      hash: "canaryHash",
      baseUrl: "u",
      name: "Spectrum-canary",
    })
    let written: string | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => initialJson,
        write: async (contents) => {
          written = contents
        },
      },
    })
    await u.setChannel("stable")
    const parsed = JSON.parse(written ?? "") as Record<string, unknown>
    expect(parsed.channel).toBe("stable")
    expect(parsed.name).toBe("Spectrum")
  })

  it("setChannel does not touch name on a same-channel switch (canary→canary)", async () => {
    // Idempotent: a canary build reaffirming canary must not rewrite name
    // (it's already correct) — only the config preference changes.
    const initialJson = JSON.stringify({
      identifier: "dev.spectrum.app",
      channel: "canary",
      version: "1.8.0-canary.2",
      hash: "canaryHash",
      baseUrl: "u",
      name: "Spectrum-canary",
    })
    let written: string | null = null
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      versionFile: {
        read: async () => initialJson,
        write: async (contents) => {
          written = contents
        },
      },
    })
    await u.setChannel("canary")
    const parsed = JSON.parse(written ?? "") as Record<string, unknown>
    expect(parsed.channel).toBe("canary")
    expect(parsed.name).toBe("Spectrum-canary")
  })

  // ── relaunch: detached per-OS restart so a channel switch takes effect ──────
  // Electrobun caches localInfo for the process lifetime (no public cache-clear),
  // so the rewritten version.json only takes effect after a restart. relaunch()
  // spawns the running app bundle detached, then quits — mirroring Updater.applyUpdate.

  it("relaunch spawns the app bundle path detached and quits, resolving ok", async () => {
    const spawns: { args: string[]; detached: boolean }[] = []
    let quitCalled = false
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      relaunchDeps: {
        spawn: (args, opts) => {
          spawns.push({ args, detached: opts?.detached === true })
        },
        appBundlePath: () => "/Apps/Spectrum.app",
        quit: () => {
          quitCalled = true
        },
        platform: "macos",
        pid: 4321,
      },
    })
    const r = await u.relaunch()
    expect(r.ok).toBe(true)
    expect(spawns.length).toBe(1)
    expect(spawns[0]?.detached).toBe(true)
    // macOS relaunch waits for the pid to exit then `open`s the app bundle.
    expect(spawns[0]?.args[0]).toBe("sh")
    expect(JSON.stringify(spawns[0]?.args)).toContain("/Apps/Spectrum.app")
    expect(quitCalled).toBe(true)
  })

  it("relaunch returns a channel-switch-failed error when spawn throws", async () => {
    const u = createElectrobunUpdater({
      loadEngine: async () => baseEngine(),
      relaunchDeps: {
        spawn: () => {
          throw new Error("spawn failed")
        },
        appBundlePath: () => "/Apps/Spectrum.app",
        quit: () => {},
        platform: "macos",
        pid: 4321,
      },
    })
    const r = await u.relaunch()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("channel-switch-failed")
  })
})
