import type { Result } from "@spectrum/utils"

export type Channel = "stable" | "canary"

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "applying"
  | "error"

/** State the adapter owns — config-free (no channel/dismissal). */
export interface RawUpdateState {
  readonly phase: UpdatePhase
  readonly currentVersion: string
  readonly latestVersion: string | null
  /**
   * The build `hash` of the latest available build (unique per build for BOTH
   * stable and canary), or null when up-to-date / unknown. Unlike
   * `latestVersion` — which canary CI never bumps (frozen at the last stable
   * `package.json` version) — the hash changes on every build, so it is the
   * correct key for per-build update dismissal. See electrobun-updater.ts.
   */
  readonly latestHash: string | null
  readonly available: boolean
  readonly progress: number
  readonly error: string | null
}

export type UpdaterErrorKind =
  | "offline"
  | "check-failed"
  | "download-failed"
  | "apply-failed"
  | "channel-switch-failed"

export interface UpdaterError {
  readonly kind: UpdaterErrorKind
  readonly detail: string
}

/**
 * The injected updater seam. The real impl wraps Electrobun's `Updater`; tests
 * inject `FakeUpdater`. The webview never sees this — it crosses via IPC as
 * `UpdateState`. `startDownload`/`apply` are fire-and-forget (a download/apply
 * may exceed the 5s IPC RPC budget); progress is observed via `getRaw()`.
 */
export interface UpdaterAdapter {
  /** Synchronous snapshot of the current raw state. */
  getRaw(): RawUpdateState
  /** Network check against the given channel; updates the raw snapshot. */
  check(channel: Channel): Promise<Result<void, UpdaterError>>
  /** Begin staging the update in the background. Returns immediately. */
  startDownload(): void
  /** Apply the staged update and relaunch. May not return (process exits). */
  apply(): Promise<Result<void, UpdaterError>>
  /**
   * Switch the followed channel. A CROSS-CHANNEL switch (stable↔canary) rewrites
   * BOTH `channel` AND `name` in the bundle's version.json: the canary bundle is
   * named "Spectrum-canary" (stable is "Spectrum"), and Electrobun builds the
   * full-bundle download URL from `name`, so flipping `channel` alone would make
   * the running app request a canary tarball that doesn't exist (404). A
   * SAME-CHANNEL switch only persists the preference (name is already correct).
   * Best-effort: a read-only bundle swallows the write error and resolves ok
   * (the config preference is still persisted by the handler); the engine then
   * picks up the change after a writable reinstall. See electrobun-updater.ts.
   */
  setChannel(channel: Channel): Promise<Result<void, UpdaterError>>
  /**
   * The channel this installed bundle actually IS, read live from the bundle's
   * version.json — the same file Electrobun derives the active update feed from.
   * This is the source of truth for the displayed channel: a canary build reports
   * "canary" here even on a fresh install whose config still holds the "stable"
   * default. `undefined` when the channel is unknown (dev build, read-only/missing
   * bundle, or a non-Channel value), in which case callers fall back to config.
   */
  getBuildChannel(): Promise<Channel | undefined>
  /**
   * Relaunch the running app bundle (detached spawn of the app/launcher, then quit)
   * so a rewritten version.json takes effect. Electrobun caches `localInfo` for the
   * process lifetime (no public cache-clear), so a channel switch is only observed
   * after a restart. Mirrors `Updater.applyUpdate`'s per-OS relaunch tail. Fire-and-
   * forget like `apply`: the process exits mid-call, so callers must not depend on
   * a returned state. Resolves `ok` before quitting; `channel-switch-failed` on a
   * spawn error (the app stays running so the user can retry / restart manually).
   */
  relaunch(): Promise<Result<void, UpdaterError>>
}
