import { type Result, err, ok } from "@spectrum/utils"
import type {
  Channel,
  RawUpdateState,
  UpdaterAdapter,
  UpdaterError,
  UpdaterErrorKind,
} from "./updater-adapter"

export interface FakeUpdaterOptions {
  readonly currentVersion: string
  /** A newer version to advertise; omit for "up to date". */
  readonly latest?: string
  /** The build `hash` of the advertised update (mirrors Electrobun's feed hash). */
  readonly latestHash?: string
  /** Make `check` fail with this error kind. */
  readonly failCheck?: UpdaterErrorKind
  /** Make `apply` fail with this error kind. */
  readonly failApply?: UpdaterErrorKind
  /** The channel the installed bundle reports (version.json). Omit for "unknown". */
  readonly buildChannel?: Channel
}

/** A test double exposing the recorded channel for assertions. */
export interface FakeUpdater extends UpdaterAdapter {
  lastChannel: Channel | null
  /** Number of times `relaunch()` was called. */
  relaunchCalls: number
  /** Number of times `check()` was called. */
  checkCalls: number
}

export const createFakeUpdater = (opts: FakeUpdaterOptions): FakeUpdater => {
  let raw: RawUpdateState = {
    phase: "idle",
    currentVersion: opts.currentVersion,
    latestVersion: null,
    latestHash: null,
    available: false,
    progress: 0,
    error: null,
  }
  const fail = (kind: UpdaterErrorKind): UpdaterError => ({
    kind,
    detail: `fake ${kind}`,
  })

  const updater: FakeUpdater = {
    lastChannel: null,
    relaunchCalls: 0,
    checkCalls: 0,
    getRaw: () => raw,
    check: async (): Promise<Result<void, UpdaterError>> => {
      updater.checkCalls++
      if (opts.failCheck !== undefined) {
        raw = { ...raw, phase: "error", error: opts.failCheck }
        return err(fail(opts.failCheck))
      }
      const available = opts.latest !== undefined
      raw = {
        ...raw,
        phase: available ? "available" : "up-to-date",
        available,
        latestVersion: opts.latest ?? null,
        latestHash: available ? (opts.latestHash ?? null) : null,
        error: null,
      }
      return ok(undefined)
    },
    startDownload: (): void => {
      raw = { ...raw, phase: "downloaded", progress: 1, error: null }
    },
    apply: async (): Promise<Result<void, UpdaterError>> => {
      if (opts.failApply !== undefined) {
        raw = { ...raw, phase: "error", error: opts.failApply }
        return err(fail(opts.failApply))
      }
      raw = { ...raw, phase: "applying" }
      return ok(undefined)
    },
    setChannel: async (
      channel: Channel,
    ): Promise<Result<void, UpdaterError>> => {
      updater.lastChannel = channel
      return ok(undefined)
    },
    // Mirrors the real adapter: a switch (lastChannel) wins over the build-time
    // channel, matching how setChannel rewrites version.json.
    getBuildChannel: async (): Promise<Channel | undefined> =>
      updater.lastChannel ?? opts.buildChannel,
    relaunch: async (): Promise<Result<void, UpdaterError>> => {
      updater.relaunchCalls++
      return ok(undefined)
    },
  }
  return updater
}
