import type { ExtensionView, IpcError } from "@spectrum/ipc"
import { useEffect } from "react"
import { useStore } from "zustand"
import { useStores } from "../stores/createStores"
import type { ExtensionsStore } from "../stores/extensionsStore"

export type UseExtensions = {
  readonly extensions: readonly ExtensionView[] | undefined
  readonly loading: boolean
  readonly error: IpcError | undefined
  readonly install: ExtensionsStore["install"]
  readonly setEnabled: ExtensionsStore["setEnabled"]
  readonly update: ExtensionsStore["update"]
  readonly remove: ExtensionsStore["remove"]
}

/** Loads the installed extensions and exposes extension-admin mutations. */
export const useExtensions = (): UseExtensions => {
  const store = useStores().extensions
  const extensions = useStore(store, (s) => s.data)
  const loading = useStore(store, (s) => s.loading)
  const error = useStore(store, (s) => s.error)
  const fetch = useStore(store, (s) => s.fetch)
  const install = useStore(store, (s) => s.install)
  const setEnabled = useStore(store, (s) => s.setEnabled)
  const update = useStore(store, (s) => s.update)
  const remove = useStore(store, (s) => s.remove)
  useEffect(() => {
    void fetch()
  }, [fetch])
  return { extensions, loading, error, install, setEnabled, update, remove }
}
