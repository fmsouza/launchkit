import type { IpcMethods } from "@spectrum/ipc"
import { type StoreApi, createStore } from "zustand/vanilla"
import type { NotificationInput } from "./notifications-model"
import type { StoreDeps } from "./types"

export type UpdateState = IpcMethods["getUpdateState"]["result"]
export type Channel = UpdateState["channel"]

/** Update store deps: the IPC client plus a sink for user-facing failure toasts. */
export type UpdateStoreDeps = StoreDeps & {
  readonly notify: (input: NotificationInput) => void
}

export interface UpdateStore {
  readonly state: UpdateState | undefined
  /** Network check (called on app open). */
  readonly check: () => Promise<void>
  /** Re-read the current state without a network check (used while polling). */
  readonly refresh: () => Promise<void>
  /** Begin the background download, then refresh once. */
  readonly download: () => Promise<void>
  /** Apply the staged update + relaunch. */
  readonly apply: () => Promise<void>
  /** Dismiss the banner for the current latest version. */
  readonly dismiss: () => Promise<void>
  /** Switch channel and adopt the returned state. */
  readonly setChannel: (channel: Channel) => Promise<void>
  /** Adopt a server-pushed UpdateState (no network check). */
  readonly onUpdateState: (state: UpdateState) => void
}

export const createUpdateStore = (
  deps: UpdateStoreDeps,
): StoreApi<UpdateStore> =>
  createStore<UpdateStore>()((set, get) => ({
    state: undefined,
    check: async () => {
      const r = await deps.client.checkForUpdate(undefined)
      if (r.ok) set({ state: r.value })
      else
        deps.notify({ tone: "error", message: "Couldn't check for updates." })
    },
    refresh: async () => {
      const r = await deps.client.getUpdateState(undefined)
      if (r.ok) set({ state: r.value })
      // Background poll: a transient refresh failure is not worth a toast.
    },
    download: async () => {
      const r = await deps.client.startUpdateDownload(undefined)
      if (!r.ok) {
        deps.notify({
          tone: "error",
          message: "Couldn't start the update download.",
        })
        return
      }
      await get().refresh()
    },
    apply: async () => {
      const r = await deps.client.applyUpdate(undefined)
      if (!r.ok)
        deps.notify({ tone: "error", message: "Couldn't apply the update." })
    },
    dismiss: async () => {
      const state = get().state
      if (state === undefined) return
      // Dismiss the banner for the current latest build. Key on the build
      // `hash` (unique per build for BOTH stable and canary) when present, so
      // a dismissed canary build stays dismissed while a NEW canary build
      // (different hash, same frozen version) re-shows the banner. When no
      // hash is surfaced (an older bundle), fall back to the version string so
      // existing users on old builds can still clear the banner.
      const hash = state.latestHash
      if (hash !== null && hash !== undefined) {
        const r = await deps.client.dismissUpdate({ hash })
        if (!r.ok) {
          deps.notify({
            tone: "error",
            message: "Couldn't dismiss the update.",
          })
          return
        }
        await get().refresh()
        return
      }
      const version = state.latestVersion
      if (version === null) return
      // Legacy path: old bundles without a build hash dismiss by version. The
      // IPC `dismissUpdate` now requires `{ hash }`, so we send the version
      // string AS the hash key for these old builds — it is still a stable
      // per-build identifier on the version-keyed path, and `decideBanner`
      // falls back to version comparison when `latestHash` is null anyway.
      const r = await deps.client.dismissUpdate({ hash: version })
      if (!r.ok) {
        deps.notify({
          tone: "error",
          message: "Couldn't dismiss the update.",
        })
        return
      }
      await get().refresh()
    },
    setChannel: async (channel) => {
      const r = await deps.client.setUpdateChannel({ channel })
      if (r.ok) set({ state: r.value })
      else
        deps.notify({
          tone: "error",
          message: "Couldn't change the update channel.",
        })
    },
    onUpdateState: (state) => {
      set({ state })
    },
  }))
