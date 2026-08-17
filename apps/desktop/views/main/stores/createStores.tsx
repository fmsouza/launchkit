import type { IpcClient } from "@spectrum/ipc"
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useState,
} from "react"
import type { StoreApi } from "zustand/vanilla"
import type { UpdateClient } from "../update/updateClient"
import { type ExtensionsStore, createExtensionsStore } from "./extensionsStore"
import { type HarnessesStore, createHarnessesStore } from "./harnessesStore"
import { type ModelsStore, createModelsStore } from "./modelsStore"
import type { NotificationInput } from "./notifications-model"
import {
  type NotificationsStore,
  createNotificationsStore,
} from "./notificationsStore"
import { type OutboxStore, createOutboxStore } from "./outboxStore"
import { type ProjectsStore, createProjectsStore } from "./projectsStore"
import { type ProvidersStore, createProvidersStore } from "./providersStore"
import { type ProxyStore, createProxyStore } from "./proxyStore"
import { type RunViewStore, createRunViewStore } from "./runViewStore"
import type { StoreDeps } from "./types"
import { type UiStore, createUiStore } from "./uiStore"
import { type UpdateStore, createUpdateStore } from "./updateStore"

/** The full bundle of domain stores. Grows as each domain is migrated. */
export type Stores = {
  readonly proxy: StoreApi<ProxyStore>
  readonly providers: StoreApi<ProvidersStore>
  readonly models: StoreApi<ModelsStore>
  readonly notifications: StoreApi<NotificationsStore>
  readonly harnesses: StoreApi<HarnessesStore>
  readonly extensions: StoreApi<ExtensionsStore>
  readonly projects: StoreApi<ProjectsStore>
  readonly ui: StoreApi<UiStore>
  readonly runView: StoreApi<RunViewStore>
  readonly update: StoreApi<UpdateStore>
  readonly outbox: StoreApi<OutboxStore>
}

export type CreateStoresOptions = {
  readonly client: IpcClient
  readonly initialView: string
  readonly updateClient: UpdateClient
}

/** Build every store once with the injected client. */
export const createStores = ({
  client,
  initialView,
  updateClient,
}: CreateStoresOptions): Stores => {
  const deps: StoreDeps = { client }
  const notifications = createNotificationsStore()
  const notify = (input: NotificationInput): void => {
    notifications.getState().notify(input)
  }
  const providers = createProvidersStore(deps)
  const providerNameResolver = (): Readonly<Record<string, string>> => {
    const out: Record<string, string> = {}
    for (const p of providers.getState().data ?? []) out[p.id] = p.name
    return out
  }
  const update = createUpdateStore({ ...deps, notify })
  updateClient.onUpdateState((state) => update.getState().onUpdateState(state))
  return {
    proxy: createProxyStore(deps),
    providers,
    models: createModelsStore({ ...deps, providerNameResolver }),
    notifications,
    harnesses: createHarnessesStore(deps),
    extensions: createExtensionsStore(deps),
    projects: createProjectsStore(deps),
    ui: createUiStore(initialView),
    runView: createRunViewStore(deps),
    update,
    outbox: createOutboxStore(deps),
  }
}

const StoresContext = createContext<Stores | null>(null)

export type StoreProviderProps = {
  readonly client: IpcClient
  readonly initialView?: string
  readonly updateClient: UpdateClient
  readonly children: ReactNode
}

/** Creates the store bundle once (per mount) and injects it via context. */
export const StoreProvider = ({
  client,
  initialView = "sessions",
  updateClient,
  children,
}: StoreProviderProps): ReactElement => {
  const [stores] = useState(() =>
    createStores({ client, initialView, updateClient }),
  )
  return (
    <StoresContext.Provider value={stores}>{children}</StoresContext.Provider>
  )
}

/** Read the injected store bundle. Throws if no provider is mounted. */
export const useStores = (): Stores => {
  const stores = useContext(StoresContext)
  if (stores === null) {
    throw new Error("useStores must be used within a StoreProvider")
  }
  return stores
}
