import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { detectPlatform } from "@spectrum/platform"
import { type Result, err, ok } from "@spectrum/utils"
import type {
  Channel,
  RawUpdateState,
  UpdaterAdapter,
  UpdaterError,
} from "./updater-adapter"

/**
 * The slice of Electrobun's `Updater` this adapter uses. Declared structurally so
 * the unit test injects a fake and the real engine is loaded lazily (no native
 * FFI under `bun test`).
 */
export interface UpdaterEngine {
  checkForUpdate(): Promise<{
    version: string
    hash: string
    // Electrobun omits this on the up-to-date (hash-matches) path — it returns the raw
    // parsed update.json, which has no `updateAvailable`. Model it as possibly-absent so
    // callers must coerce rather than trust an undefined as a boolean.
    updateAvailable?: boolean
  }>
  downloadUpdate(): Promise<void>
  applyUpdate(): Promise<void>
  onStatusChange(
    cb: (e: { status: string; details?: { progress?: number } }) => void,
  ): void
  localInfo: { version(): Promise<string> }
}

/** Options passed to the injected `spawn` seam (mirrors the `Bun.spawn` subset we use). */
export interface RelaunchSpawnOptions {
  readonly detached?: boolean
  readonly stdio?: readonly ("ignore" | "pipe")[]
}

/** OS the relaunch runs on (selects the per-OS spawn command). */
export type RelaunchPlatform = "macos" | "linux" | "windows"

/**
 * Injected relaunch primitives. Production wires `Bun.spawn`, the running app
 * bundle path (mirroring `Updater.applyUpdate`'s path computation), `quit` from
 * `electrobun/bun`, and the live OS/pid. Tests inject fakes so the per-OS spawn
 * command + quit ordering is unit-testable without native FFI.
 */
export interface RelaunchDeps {
  /** Detached spawn of a command (the relaunch script / launcher). */
  readonly spawn: (args: string[], opts?: RelaunchSpawnOptions) => void
  /** The running app bundle path to relaunch (e.g. `/Apps/Spectrum.app`). */
  readonly appBundlePath: () => string
  /** Graceful quit (closes windows + native cleanup + exit). */
  readonly quit: () => void
  /** The OS we're relaunching on. */
  readonly platform: RelaunchPlatform
  /** The current process pid (macOS waits for it to exit before `open`). */
  readonly pid: number
}

export interface ElectrobunUpdaterDeps {
  /** Resolve the engine. Production lazily imports Electrobun; tests inject a fake. */
  readonly loadEngine: () => Promise<UpdaterEngine>
  /** Read/write the bundle's Resources/version.json (channel switch). Injected for tests. */
  readonly versionFile?: {
    read: () => Promise<string>
    write: (contents: string) => Promise<void>
  }
  /** Relaunch primitives. Injected for tests; production wires Bun.spawn + quit. */
  readonly relaunchDeps?: RelaunchDeps
}

/**
 * The on-disk bundle `name` for a channel — the value baked into version.json and
 * the base of the full-bundle tarball filename Electrobun requests. Stable is the
 * plain app name; non-stable channels suffix it (`Spectrum-canary`). Mirrors
 * Electrobun's `getAppFileName` (`dist/api/shared/naming.ts`) so the URL the
 * running app builds (`${baseUrl}/${prefix}-${tarballName}`) matches a published
 * asset. Pure + unit-tested so the mapping is explicit, not a magic string inline.
 */
export const channelBundleName = (channel: Channel): string =>
  channel === "stable" ? "Spectrum" : `Spectrum-${channel}`

/** Production loader: lazy-import so `bun test` never loads native FFI. */
const realLoadEngine = async (): Promise<UpdaterEngine> => {
  const { Updater } = (await import("electrobun/bun")) as unknown as {
    Updater: UpdaterEngine
  }
  return Updater
}

/** Production version.json accessor (Electrobun uses ../Resources/version.json relative to process cwd). */
const realVersionFile = {
  read: (): Promise<string> => Bun.file("../Resources/version.json").text(),
  write: (contents: string): Promise<void> =>
    Bun.write("../Resources/version.json", contents).then(() => undefined),
}

/**
 * Production relaunch primitives. The running app bundle path mirrors
 * `Updater.applyUpdate`'s computation (Updater.ts): macOS resolves the .app from
 * the executable's bundle-relative path; Linux/Windows run from the app-data `app`
 * dir's launcher binary. `quit` is Electrobun's graceful quit (Utils.quit, native
 * cleanup + exit). `platform` maps `@spectrum/platform`'s detectPlatform; `pid` is
 * the live pid.
 */
const realRelaunchDeps: RelaunchDeps = {
  spawn: (args, opts): void => {
    // Detached spawn so the child survives our quit. `stdio` silenced.
    const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
      detached: opts?.detached ?? false,
      stdio: ["ignore", "ignore", "ignore"],
    }
    void Bun.spawn(args, spawnOpts)
  },
  appBundlePath: (): string => {
    const platform = detectPlatform()
    if (platform === "macos") {
      // Contents/MacOS/<bun> → Contents → <Bundle>.app
      return resolve(dirname(process.execPath), "..", "..")
    }
    // Linux/Windows: the app lives in {appData}/app and launches via bin/launcher.
    return join(
      homedir(),
      platform === "linux" ? ".local/share" : "AppData/Local",
      "Spectrum",
      "app",
      "bin",
      platform === "linux" ? "launcher" : "launcher.exe",
    )
  },
  quit: (): void => {
    // Lazy import so `bun test` never loads native FFI.
    void import("electrobun/bun")
      .then(({ Utils }) => Utils.quit())
      .catch(() => {
        /* best-effort: a quit failure leaves the process running — the user can restart manually */
      })
  },
  platform: ((): RelaunchPlatform => {
    const p = detectPlatform()
    return p === "macos" || p === "linux" || p === "windows" ? p : "macos"
  })(),
  pid: process.pid,
}

export const createElectrobunUpdater = (
  deps: ElectrobunUpdaterDeps = { loadEngine: realLoadEngine },
): UpdaterAdapter => {
  let raw: RawUpdateState = {
    phase: "idle",
    currentVersion: "",
    latestVersion: null,
    latestHash: null,
    available: false,
    progress: 0,
    error: null,
  }
  let subscribed = false

  let enginePromise: Promise<UpdaterEngine> | null = null
  const engine = (): Promise<UpdaterEngine> => {
    if (enginePromise === null) enginePromise = deps.loadEngine()
    return enginePromise
  }

  const subscribe = (eng: UpdaterEngine): void => {
    if (subscribed) return
    subscribed = true
    eng.onStatusChange((e) => {
      switch (e.status) {
        case "downloading":
        case "downloading-full-bundle":
        case "downloading-patch":
          raw = { ...raw, phase: "downloading", error: null }
          break
        case "download-progress":
          raw = {
            ...raw,
            phase: "downloading",
            progress: toFraction(e.details?.progress, raw.progress),
          }
          break
        case "download-complete":
        case "patch-chain-complete":
          raw = { ...raw, phase: "downloaded", progress: 1 }
          break
        case "error":
          // A late error (e.g. post-download cleanup) must not regress a
          // successfully staged update back to a failed state.
          if (raw.phase !== "downloaded") {
            raw = { ...raw, phase: "error", error: "download-failed" }
          }
          break
        default:
          break
      }
    })
  }

  return {
    getRaw: () => raw,

    check: async (_channel: Channel): Promise<Result<void, UpdaterError>> => {
      raw = { ...raw, phase: "checking", error: null }
      try {
        const eng = await engine()
        subscribe(eng)
        const current = await eng.localInfo.version()
        const info = await eng.checkForUpdate()
        // Electrobun's checkForUpdate returns the raw parsed update.json on the
        // hash-matches path, which has NO `updateAvailable` field (undefined). Coerce
        // to a strict boolean so the IPC result-validation (UpdateStateSchema requires
        // `available: boolean`) never rejects an up-to-date check.
        const available = info.updateAvailable === true
        raw = {
          ...raw,
          phase: available ? "available" : "up-to-date",
          currentVersion: current,
          available,
          latestVersion: available ? info.version : null,
          // The build `hash` is unique per build for BOTH stable and canary
          // (canary CI never bumps package.json version, so `latestVersion`
          // repeats across canary builds — see updater-adapter.ts). Keying
          // update dismissal on the hash (not the version) is what lets a
          // dismissed canary build stay dismissed while a *new* canary build
          // re-shows the banner. Electrobun only omits `hash` on an error
          // parse path where `available` is already false.
          latestHash: available ? info.hash : null,
          error: null,
        }
        return ok(undefined)
      } catch (e) {
        raw = { ...raw, phase: "error", error: "offline" }
        return err({ kind: "offline", detail: errorText(e) })
      }
    },

    startDownload: (): void => {
      raw = { ...raw, phase: "downloading", progress: 0, error: null }
      // Fire-and-forget: a download can exceed the 5s IPC budget. Progress and
      // completion flow through the onStatusChange subscription into `raw`.
      void engine()
        .then((eng) => {
          subscribe(eng)
          return eng.downloadUpdate()
        })
        .catch(() => {
          raw = { ...raw, phase: "error", error: "download-failed" }
        })
    },

    apply: async (): Promise<Result<void, UpdaterError>> => {
      raw = { ...raw, phase: "applying", error: null }
      try {
        const eng = await engine()
        await eng.applyUpdate() // swaps the bundle + relaunches (may not return)
        return ok(undefined)
      } catch (e) {
        raw = { ...raw, phase: "error", error: "apply-failed" }
        return err({ kind: "apply-failed", detail: errorText(e) })
      }
    },

    setChannel: async (
      channel: Channel,
    ): Promise<Result<void, UpdaterError>> => {
      // Electrobun derives the active channel AND the full-bundle download URL from
      // the bundle's Resources/version.json (`localInfo.channel` + `localInfo.name`),
      // which Updater caches for the process lifetime (no public cache-clear). So a
      // channel switch is written to that file and takes effect on the NEXT app
      // restart. The catch: a stable bundle is named "Spectrum" and a canary bundle
      // "Spectrum-canary"; Electrobun builds the tarball URL as
      // `${baseUrl}/${channel-prefix}-${name}.app.tar.zst`, so flipping `channel` alone
      // leaves `name="Spectrum"` and the running app requests a canary tarball that was
      // never published under that name (404) — the download silently fails. A
      // CROSS-CHANNEL switch therefore rewrites BOTH `channel` and `name` to the
      // target channel's bundle name, so after restart the app requests the real asset.
      // A SAME-CHANNEL switch (canary→canary) leaves `name` untouched — it's already
      // correct; only the config preference changes. Best-effort: a read-only bundle
      // swallows the write error (preference still persists in config via the handler).
      const vf = deps.versionFile ?? realVersionFile
      try {
        const raw = await vf.read()
        const parsed = JSON.parse(raw) as Record<string, unknown>
        // The current channel, read before we overwrite it. Only a valid Channel
        // counts as a real "from" — a dev build (or missing field) has no bundle
        // name to migrate, so leave name untouched and just persist the preference.
        const fromChannel =
          parsed.channel === "stable" || parsed.channel === "canary"
            ? (parsed.channel as Channel)
            : undefined
        parsed.channel = channel
        // Rewrite name only on a real cross-channel switch (stable↔canary). A
        // same-channel switch keeps the existing (already-correct) name; a dev
        // build (fromChannel undefined) keeps "Spectrum-dev" — channel is a
        // preference there, not a migration (dev is update-disabled).
        if (fromChannel !== undefined && fromChannel !== channel) {
          parsed.name = channelBundleName(channel)
        }
        await vf.write(JSON.stringify(parsed, null, 2))
      } catch {
        // swallow — preference persists in config; engine picks it up after a writable reinstall
      }
      return ok(undefined)
    },

    getBuildChannel: async (): Promise<Channel | undefined> => {
      // Read the live version.json — the same file Electrobun follows. Only a
      // valid Channel is returned; "dev"/missing/malformed yields undefined so
      // the caller falls back to the config-stored preference.
      const vf = deps.versionFile ?? realVersionFile
      try {
        const parsed = JSON.parse(await vf.read()) as { channel?: unknown }
        return parsed.channel === "stable" || parsed.channel === "canary"
          ? parsed.channel
          : undefined
      } catch {
        return undefined
      }
    },

    relaunch: async (): Promise<Result<void, UpdaterError>> => {
      // Spawn the running app detached, then quit. The fresh process reloads
      // version.json (with the rewritten channel+name) so Electrobun's cached
      // localInfo is reset and the new channel's feed/URLs take effect. Mirrors
      // Updater.applyUpdate's per-OS relaunch tail (Updater.ts:1067-1097).
      const rd = deps.relaunchDeps ?? realRelaunchDeps
      try {
        const appPath = rd.appBundlePath()
        if (rd.platform === "macos") {
          // macOS `open` on a running app just activates it, so wait for this pid
          // to exit before reopening (the detached shell survives our quit).
          rd.spawn(
            [
              "sh",
              "-c",
              `while kill -0 ${rd.pid} 2>/dev/null; do sleep 0.5; done; sleep 1; open "${appPath}"`,
            ],
            { detached: true, stdio: ["ignore", "ignore", "ignore"] },
          )
        } else if (rd.platform === "linux") {
          // Linux: launch the launcher binary inside the app directory.
          rd.spawn(["sh", "-c", `"${appPath}" &`], { detached: true })
        } else {
          // Windows: spawn the launcher then quit (no file replacement here, so
          // the scheduled-task .bat applyUpdate uses isn't needed for a relaunch).
          rd.spawn([appPath], { detached: true })
        }
        // Resolve ok before quitting so the IPC RPC returns a success result.
        rd.quit()
        return ok(undefined)
      } catch (e) {
        return err({ kind: "channel-switch-failed", detail: errorText(e) })
      }
    },
  }
}

/** Message-safe error text (no stack), for the `detail` field. */
const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/** Electrobun emits download progress as a 0–100 percentage; normalize to 0–1, clamped. */
const toFraction = (pct: number | undefined, fallback: number): number => {
  if (pct === undefined) return fallback
  const f = pct / 100
  return f < 0 ? 0 : f > 1 ? 1 : f
}
