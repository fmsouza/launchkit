import type { ConfigStore } from "@spectrum/config"
import type { UpdateState } from "@spectrum/ipc"
import { isOk } from "@spectrum/utils"
import { decideBanner } from "./policy"
import type { Channel, UpdaterAdapter } from "./updater-adapter"

/**
 * Build the full UpdateState by combining the raw adapter snapshot with the displayed channel
 * and config-owned dismissal field. Pure-ish helper shared by the IPC handlers and the
 * composition-layer push path so there is one source of truth for `showBanner`.
 *
 * The displayed channel is the bundle's ACTUAL channel (version.json, what Electrobun follows),
 * so a canary build reports "canary" even on a fresh install whose config holds the "stable"
 * default. The config-stored preference is the fallback when the build channel is unknown; a
 * final "stable" fallback covers a config-load failure so a failure never blanks the box.
 */
export const buildUpdateState = async (deps: {
  readonly updater: UpdaterAdapter
  readonly config: ConfigStore
}): Promise<UpdateState> => {
  const loaded = await deps.config.load()
  const buildChannel = await deps.updater.getBuildChannel()
  const channel: Channel =
    buildChannel ??
    (isOk(loaded) ? loaded.value.settings.updateChannel : "stable")
  const settings = isOk(loaded) ? loaded.value.settings : null
  const dismissedVersion = settings?.dismissedUpdateVersion ?? null
  const dismissedHash = settings?.dismissedUpdateHash ?? null
  const raw = deps.updater.getRaw()
  const showBanner =
    decideBanner({
      available: raw.available,
      latestVersion: raw.latestVersion,
      latestHash: raw.latestHash,
      dismissedVersion,
      dismissedHash,
    }) === "show"
  return { ...raw, channel, showBanner }
}
