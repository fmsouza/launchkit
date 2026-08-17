import type { ExtensionView, IpcError, IpcMethods } from "@spectrum/ipc"
import type { PluginId } from "@spectrum/types"
import type { Result } from "@spectrum/utils"
import { type StoreApi, createStore } from "zustand/vanilla"
import { type ResourceState, createResource } from "./resource"
import type { StoreDeps } from "./types"

type InstallInput = IpcMethods["installExtension"]["params"]
type RemoveResult = IpcMethods["removeExtension"]["result"]

/** The `in-use` shape carved out of `RemoveExtensionResultSchema`'s union. */
export type RemoveRefusal = Extract<RemoveResult, { readonly refused: unknown }>

export type ExtensionsStore = ResourceState<readonly ExtensionView[]> & {
  readonly install: (input: InstallInput) => Promise<Result<void, IpcError>>
  readonly setEnabled: (
    id: PluginId,
    enabled: boolean,
  ) => Promise<Result<void, IpcError>>
  readonly update: (id: PluginId) => Promise<Result<void, IpcError>>
  /**
   * Resolves Ok with the refusal payload when the extension is still in use (spec §3: a
   * DATA refusal, not a transport error) so the page can name the referencing providers;
   * Ok with `undefined` on an actual removal.
   */
  readonly remove: (
    id: PluginId,
  ) => Promise<Result<RemoveRefusal["refused"] | undefined, IpcError>>
}

const isRefusal = (value: RemoveResult): value is RemoveRefusal =>
  typeof value === "object" &&
  value !== null &&
  "refused" in (value as Record<string, unknown>)

export const createExtensionsStore = (
  deps: StoreDeps,
): StoreApi<ExtensionsStore> =>
  createStore<ExtensionsStore>()((set, get) => ({
    ...createResource<readonly ExtensionView[]>(
      () => deps.client.listExtensions(undefined),
      (patch) => set(patch),
      () => get().data,
    ),
    // Mutations return the refreshed list directly (Task 5) — write it straight into the
    // store instead of triggering a second round trip via invalidate().
    install: async (input): Promise<Result<void, IpcError>> => {
      const r = await deps.client.installExtension(input)
      if (!r.ok) return r
      set({ data: r.value, error: undefined })
      return { ok: true, value: undefined }
    },
    setEnabled: async (id, enabled): Promise<Result<void, IpcError>> => {
      const r = await deps.client.setExtensionEnabled({ id, enabled })
      if (!r.ok) return r
      set({ data: r.value, error: undefined })
      return { ok: true, value: undefined }
    },
    update: async (id): Promise<Result<void, IpcError>> => {
      const r = await deps.client.updateExtension({ id })
      if (!r.ok) return r
      set({ data: r.value, error: undefined })
      return { ok: true, value: undefined }
    },
    remove: async (
      id,
    ): Promise<Result<RemoveRefusal["refused"] | undefined, IpcError>> => {
      const r = await deps.client.removeExtension({ id })
      if (!r.ok) return r
      if (isRefusal(r.value)) return { ok: true, value: r.value.refused }
      set({ data: r.value, error: undefined })
      return { ok: true, value: undefined }
    },
  }))
